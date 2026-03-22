/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Legacy hooks for packaging when the GitHub Copilot native packages were bundled.
 * The agent host now uses local Ollama only; these remain as no-ops for compatibility.
 */
export function getCopilotExcludeFilter(_platform: string, _arch: string): string[] {
	return ['**'];
}

export function copyCopilotNativeDeps(_platform: string, _arch: string, _nodeModulesDir: string): void {
	// no-op
}
