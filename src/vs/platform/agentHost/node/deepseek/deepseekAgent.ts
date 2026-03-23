/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IAuthorizationProtectedResourceMetadata } from '../../../../base/common/oauth.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { LogService } from '../../../log/common/logService.js';
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

/** Default model for DeepSeek */
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';

function getDeepSeekApiKey(): string {
	return process.env['DEEPSEEK_API_KEY'] ?? '';
}

function getDeepSeekBaseUrl(): string {
	return process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com';
}

interface IStoredChatMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly messageId: string;
}

class DeepSeekSessionState {
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
 * Agent provider backed by DeepSeek API service.
 */
export class DeepSeekAgent extends Disposable implements IAgent {
	readonly id = 'deepseek' as const;

	private readonly _onDidSessionProgress = this._register(new Emitter<IAgentProgressEvent>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _sessions = new Map<string, DeepSeekSessionState>();
	private readonly _baseUrl: string;
	private readonly _apiKey: string;

	constructor(
		private readonly _logService: LogService,
	) {
		super();
		this._baseUrl = getDeepSeekBaseUrl();
		this._apiKey = getDeepSeekApiKey();
		this._logService.info(`[DeepSeek] Base URL: ${this._baseUrl}, model: ${DEFAULT_DEEPSEEK_MODEL}`);
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: 'DeepSeek',
			description: `Cloud models from DeepSeek service. Using ${DEFAULT_DEEPSEEK_MODEL} model.`,
			requiresAuth: true,
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
		if (!this._apiKey) {
			this._logService.warn('[DeepSeek] No API key provided');
			return [];
		}

		return [{
			provider: this.id,
			id: DEFAULT_DEEPSEEK_MODEL,
			name: 'DeepSeek Chat',
			maxContextWindow: 32768,
			supportsVision: false,
			supportsReasoningEffort: false,
			policyState: undefined as PolicyState | undefined,
		}];
	}

	async createSession(config?: IAgentCreateSessionConfig): Promise<URI> {
		const sessionId = config?.session ? AgentSession.id(config.session) : generateUuid();
		if (this._sessions.has(sessionId)) {
			return AgentSession.uri(this.id, sessionId);
		}
		const model = config?.model ?? DEFAULT_DEEPSEEK_MODEL;
		const state = new DeepSeekSessionState(sessionId, model);
		this._sessions.set(sessionId, state);
		this._logService.info(`[DeepSeek] Session created: ${sessionId} model=${model}`);
		return AgentSession.uri(this.id, sessionId);
	}

	async sendMessage(session: URI, prompt: string, attachments?: IAgentAttachment[]): Promise<void> {
		const sessionId = AgentSession.id(session);
		const state = this._sessions.get(sessionId);
		if (!state) {
			throw new Error(`[DeepSeek] Session not found: ${sessionId}`);
		}

		if (!this._apiKey) {
			this._onDidSessionProgress.fire({
				session,
				type: 'error',
				errorType: 'auth',
				message: 'DeepSeek API key not configured. Please set DEEPSEEK_API_KEY environment variable.',
			});
			this._onDidSessionProgress.fire({ session, type: 'idle' });
			return;
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
						const fs = await import('fs');
						const text = await fs.promises.readFile(a.path, 'utf8');
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

		const deepseekMessages = state.messages.map(m => ({ role: m.role, content: m.content }));

		const url = `${this._baseUrl}/chat/completions`;
		this._logService.info(`[DeepSeek:${sessionId}] POST ${url} model=${state.model}`);

		let res: Response;
		try {
			res = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this._apiKey}`,
				},
				body: JSON.stringify({
					model: state.model,
					messages: deepseekMessages,
					stream: true,
					temperature: 0.7,
					max_tokens: 4096,
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
				message: `DeepSeek error ${res.status}: ${detail}`,
			});
			this._onDidSessionProgress.fire({ session, type: 'idle' });
			return;
		}

		let fullAssistant = '';
		let inputTokens: number | undefined;
		let outputTokens: number | undefined;

		try {
			for await (const line of this._readSseLines(res.body)) {
				if (line.startsWith('data: ')) {
					const data = line.slice(6);
					if (data === '[DONE]') {
						break;
					}
					try {
						const chunk = JSON.parse(data);
						const delta = chunk.choices?.[0]?.delta?.content ?? '';
						if (delta) {
							fullAssistant += delta;
							this._onDidSessionProgress.fire({
								session,
								type: 'delta',
								messageId: assistantMessageId,
								content: delta,
							});
						}
						if (chunk.usage) {
							inputTokens = chunk.usage.prompt_tokens;
							outputTokens = chunk.usage.completion_tokens;
						}
					} catch {
						continue;
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

	private async *_readSseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
			this._logService.info(`[DeepSeek:${sessionId}] Aborting stream`);
			state.abortController.abort();
		}
	}

	async changeModel(session: URI, model: string): Promise<void> {
		const sessionId = AgentSession.id(session);
		const state = this._sessions.get(sessionId);
		if (state) {
			this._logService.info(`[DeepSeek:${sessionId}] Model -> ${model}`);
			state.model = model;
		}
	}

	respondToPermissionRequest(_requestId: string, _approved: boolean): void {
		// DeepSeek does not emit permission requests.
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
