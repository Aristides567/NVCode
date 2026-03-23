/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	console.log('Groq extension is now active!');

	// The actual language model provider is registered in the main agent host service
	// This extension just provides the configuration and metadata
}

export function deactivate() {
	console.log('Groq extension deactivated');
}
