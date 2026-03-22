/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IAuthorizationProtectedResourceMetadata } from '../../../../base/common/oauth.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../log/common/log.js';
import {
	AgentSession,
	IAgent,
	IAgentAttachment,
	IAgentCreateSessionConfig,
	IAgentDescriptor,
	IAgentMessageEvent,
	IAgentModelInfo,
	IAgentProgressEvent,
	IAgentSessionMetadata,
	IAgentToolCompleteEvent,
	IAgentToolStartEvent,
} from '../../common/agentService.js';
import type { PolicyState } from '../../common/state/sessionState.js';
import { AttachmentType } from '../../common/state/protocol/state.js';

/** Default model when Ollama has no tags or none selected. */
export const DEFAULT_OLLAMA_MODEL = 'deepseek-coder-v2:16b';

function getOllamaBaseUrl(): string {
	const h = process.env['OLLAMA_HOST'];
	if (h) {
		const trimmed = h.replace(/\/$/, '');
		if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
			return trimmed;
		}
		return `http://${trimmed}`;
	}
	return 'http://127.0.0.1:11434';
}

function getDefaultModelName(): string {
	return process.env['OLLAMA_MODEL'] ?? DEFAULT_OLLAMA_MODEL;
}

interface IStoredChatMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly messageId: string;
}

class OllamaSessionState {
	readonly createdAt: number;
	modifiedAt: number;
	summary: string | undefined;
	abortController: AbortController | undefined;
	messages: IStoredChatMessage[] = [];

	constructor(
		readonly sessionId: string,
		public model: string,
	) {
		const now = Date.now();
		this.createdAt = now;
		this.modifiedAt = now;
	}
}

/**
 * Agent provider backed by a local Ollama server (OpenAI-compatible chat API).
 */
export class OllamaAgent extends Disposable implements IAgent {
	readonly id = 'ollama' as const;

	private readonly _onDidSessionProgress = this._register(new Emitter<IAgentProgressEvent>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _sessions = new Map<string, OllamaSessionState>();
	private readonly _baseUrl: string;
	private readonly _fallbackModel: string;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._baseUrl = getOllamaBaseUrl();
		this._fallbackModel = getDefaultModelName();
		this._logService.info(`[Ollama] Base URL: ${this._baseUrl}, default model: ${this._fallbackModel}`);
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: 'Ollama',
			description: `Local models from Ollama at ${this._baseUrl}. All pulled models appear in the chat model picker; initial default: ${this._fallbackModel}.`,
			requiresAuth: false,
		};
	}

	getProtectedResources(): IAuthorizationProtectedResourceMetadata[] {
		return [];
	}

	async authenticate(_resource: string, _token: string): Promise<boolean> {
		return false;
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		const result: IAgentSessionMetadata[] = [];
		for (const [sessionId, s] of this._sessions) {
			result.push({
				session: AgentSession.uri(this.id, sessionId),
				startTime: s.createdAt,
				modifiedTime: s.modifiedAt,
				summary: s.summary,
			});
		}
		return result;
	}

	async listModels(): Promise<IAgentModelInfo[]> {
		const url = `${this._baseUrl}/api/tags`;
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
			if (!res.ok) {
				this._logService.warn(`[Ollama] listModels failed: ${res.status} ${res.statusText}`);
				return [this._singleFallbackModelInfo()];
			}
			const data = (await res.json()) as { models?: { name: string }[] };
			const names = data.models?.map(m => m.name) ?? [];
			if (names.length === 0) {
				return [this._singleFallbackModelInfo()];
			}
			return names.map(name => ({
				provider: this.id,
				id: name,
				name,
				maxContextWindow: 131072,
				supportsVision: false,
				supportsReasoningEffort: false,
				policyState: undefined as PolicyState | undefined,
			}));
		} catch (e) {
			this._logService.warn(`[Ollama] listModels error: ${e}`);
			return [this._singleFallbackModelInfo()];
		}
	}

	private _singleFallbackModelInfo(): IAgentModelInfo {
		return {
			provider: this.id,
			id: this._fallbackModel,
			name: this._fallbackModel,
			maxContextWindow: 131072,
			supportsVision: false,
			supportsReasoningEffort: false,
		};
	}

	async createSession(config?: IAgentCreateSessionConfig): Promise<URI> {
		const sessionId = config?.session ? AgentSession.id(config.session) : generateUuid();
		if (this._sessions.has(sessionId)) {
			return AgentSession.uri(this.id, sessionId);
		}
		const model = config?.model ?? this._fallbackModel;
		const state = new OllamaSessionState(sessionId, model);
		this._sessions.set(sessionId, state);
		this._logService.info(`[Ollama] Session created: ${sessionId} model=${model}`);
		return AgentSession.uri(this.id, sessionId);
	}

	async sendMessage(session: URI, prompt: string, attachments?: IAgentAttachment[]): Promise<void> {
		const sessionId = AgentSession.id(session);
		const state = this._sessions.get(sessionId);
		if (!state) {
			throw new Error(`[Ollama] Session not found: ${sessionId}`);
		}

		const userMessageId = generateUuid();
		let userContent = prompt;
		if (attachments?.length) {
			const parts: string[] = [prompt, '', '---', 'Attachments:', ''];
			for (const a of attachments) {
				if (a.type === AttachmentType.Selection) {
					parts.push(`### Selection: ${a.displayName ?? a.path}`);
					parts.push('```');
					parts.push(a.text ?? '');
					parts.push('```', '');
				} else if (a.type === AttachmentType.File) {
					try {
						const text = await fs.readFile(a.path, 'utf8');
						parts.push(`### File: ${a.displayName ?? a.path}`);
						parts.push('```');
						parts.push(text);
						parts.push('```', '');
					} catch (e) {
						parts.push(`### File: ${a.path} (could not read: ${e})`, '');
					}
				} else {
					parts.push(`### ${a.type}: ${a.displayName ?? a.path}`, '');
				}
			}
			userContent = parts.join('\n');
		}

		state.messages.push({ role: 'user', content: userContent, messageId: userMessageId });
		if (!state.summary) {
			state.summary = prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt;
		}
		state.modifiedAt = Date.now();

		const assistantMessageId = generateUuid();
		const ac = new AbortController();
		state.abortController = ac;

		const ollamaMessages = state.messages.map(m => ({ role: m.role, content: m.content }));

		const url = `${this._baseUrl}/api/chat`;
		this._logService.info(`[Ollama:${sessionId}] POST ${url} model=${state.model}`);

		let res: Response;
		try {
			res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: state.model,
					messages: ollamaMessages,
					stream: true,
				}),
				signal: ac.signal,
			});
		} catch (e) {
			state.abortController = undefined;
			this._onDidSessionProgress.fire({
				session,
				type: 'error',
				errorType: 'network',
				message: String(e),
			});
			this._onDidSessionProgress.fire({ session, type: 'idle' });
			return;
		}

		if (!res.ok || !res.body) {
			state.abortController = undefined;
			let detail = res.statusText;
			try {
				detail = await res.text();
			} catch { /* ignore */ }
			this._onDidSessionProgress.fire({
				session,
				type: 'error',
				errorType: 'http',
				message: `Ollama error ${res.status}: ${detail}`,
			});
			this._onDidSessionProgress.fire({ session, type: 'idle' });
			return;
		}

		let fullAssistant = '';
		let inputTokens: number | undefined;
		let outputTokens: number | undefined;

		try {
			for await (const line of this._readNdjsonLines(res.body)) {
				let chunk: {
					message?: { content?: string };
					done?: boolean;
					prompt_eval_count?: number;
					eval_count?: number;
				};
				try {
					chunk = JSON.parse(line);
				} catch {
					continue;
				}
				const delta = chunk.message?.content ?? '';
				if (delta) {
					fullAssistant += delta;
					this._onDidSessionProgress.fire({
						session,
						type: 'delta',
						messageId: assistantMessageId,
						content: delta,
					});
				}
				if (chunk.done) {
					if (chunk.prompt_eval_count !== undefined) {
						inputTokens = chunk.prompt_eval_count;
					}
					if (chunk.eval_count !== undefined) {
						outputTokens = chunk.eval_count;
					}
				}
			}
		} catch (e) {
			if ((e as Error).name !== 'AbortError') {
				this._onDidSessionProgress.fire({
					session,
					type: 'error',
					errorType: 'stream',
					message: String(e),
				});
			}
			state.abortController = undefined;
			this._onDidSessionProgress.fire({ session, type: 'idle' });
			return;
		}

		state.abortController = undefined;
		state.messages.push({ role: 'assistant', content: fullAssistant, messageId: assistantMessageId });
		state.modifiedAt = Date.now();

		this._onDidSessionProgress.fire({
			session,
			type: 'message',
			role: 'assistant',
			messageId: assistantMessageId,
			content: fullAssistant,
		});

		if (inputTokens !== undefined || outputTokens !== undefined) {
			this._onDidSessionProgress.fire({
				session,
				type: 'usage',
				inputTokens,
				outputTokens,
				model: state.model,
			});
		}

		this._onDidSessionProgress.fire({ session, type: 'idle' });
	}

	private async *_readNdjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const t = line.trim();
				if (t) {
					yield t;
				}
			}
		}
		const tail = buffer.trim();
		if (tail) {
			yield tail;
		}
	}

	async getSessionMessages(session: URI): Promise<(IAgentMessageEvent | IAgentToolStartEvent | IAgentToolCompleteEvent)[]> {
		const sessionId = AgentSession.id(session);
		const state = this._sessions.get(sessionId);
		if (!state) {
			return [];
		}
		const out: IAgentMessageEvent[] = [];
		for (const m of state.messages) {
			out.push({
				session,
				type: 'message',
				role: m.role,
				messageId: m.messageId,
				content: m.content,
			});
		}
		return out;
	}

	async disposeSession(session: URI): Promise<void> {
		const sessionId = AgentSession.id(session);
		const state = this._sessions.get(sessionId);
		if (state?.abortController) {
			state.abortController.abort();
		}
		this._sessions.delete(sessionId);
	}

	async abortSession(session: URI): Promise<void> {
		const sessionId = AgentSession.id(session);
		const state = this._sessions.get(sessionId);
		if (state?.abortController) {
			this._logService.info(`[Ollama:${sessionId}] Aborting stream`);
			state.abortController.abort();
		}
	}

	async changeModel(session: URI, model: string): Promise<void> {
		const sessionId = AgentSession.id(session);
		const state = this._sessions.get(sessionId);
		if (state) {
			this._logService.info(`[Ollama:${sessionId}] Model -> ${model}`);
			state.model = model;
		}
	}

	respondToPermissionRequest(_requestId: string, _approved: boolean): void {
		// Local Ollama does not emit permission requests.
	}

	async shutdown(): Promise<void> {
		for (const [, state] of this._sessions) {
			state.abortController?.abort();
		}
		this._sessions.clear();
	}

	override dispose(): void {
		void this.shutdown();
		super.dispose();
	}
}
