/**
 * Instance Attribute Guard
 *
 * Prevents editing of pattern instance elements in non-wp_block post type
 * HTML files. Pattern instances are single self-closing tags:
 *
 *   <section data-skylit-pattern-ref-id="..."
 *            data-skylit-override-data='{"slot":{"content":"..."}}'></section>
 *
 * The entire tag is protected. Override values are edited via Gutenberg,
 * not in the HTML file.
 *
 * Everything outside pattern instance sections is freely editable.
 * Pattern originals (wp_block in patterns/ folder) are never guarded.
 *
 * Only activates for files whose WordPress Sync Metadata declares:
 *   Display Mode: phantom_blocks
 *
 * Enable by setting PATTERN_INSTANCE_GUARD_ENABLED to true and calling .start() from extension.ts.
 */

import * as vscode from "vscode";

/** When false (default), the guard does not run: no edit blocking, no gray decorations. */
export const PATTERN_INSTANCE_GUARD_ENABLED = false;
import { DebugLogger } from "./debugLogger";

/**
 * Represents a protected range in the document where editing is blocked
 */
interface ProtectedRange {
	/** Start offset in the document (0-based character offset) */
	start: number;
	/** End offset in the document (exclusive) */
	end: number;
	/** Description for debug logging */
	label: string;
}

/**
 * Cached protection data for a document
 */
interface DocumentProtectionCache {
	/** Document version when this cache was built */
	version: number;
	/** Protected ranges within the document */
	ranges: ProtectedRange[];
}

export class InstanceAttributeGuard {
	private debugLogger: DebugLogger;
	private disposables: vscode.Disposable[] = [];

	/** Cache of protected ranges per document URI */
	private protectionCache: Map<string, DocumentProtectionCache> =
		new Map();

	/**
	 * Set of document URIs that are confirmed guarded files.
	 * Determined on file open/reload — NOT re-evaluated on every keystroke.
	 */
	private guardedDocuments: Set<string> = new Set();

	/** Decoration for protected tags — grayed out with purple underline */
	private protectedDecorationType: vscode.TextEditorDecorationType;

	/** Flag to suppress re-entrant change events during reverts */
	private isReverting: boolean = false;

	/**
	 * Flag to bypass the guard for programmatic/sync writes.
	 * Set to true before writing export data to files, false after.
	 * This prevents the guard from reverting legitimate WordPress exports.
	 */
	public bypassGuard: boolean = false;

	/** Throttle timer for status bar warnings */
	private warningThrottleTimer: NodeJS.Timeout | null = null;

	constructor(devFolder: string, debugLogger: DebugLogger) {
		this.debugLogger = debugLogger;

		// Grayed-out text = pattern instance slot (read-only)
		this.protectedDecorationType =
			vscode.window.createTextEditorDecorationType({
				opacity: "0.45",
			});
	}

	/**
	 * Start the guard
	 */
	public start(): void {
		if (!PATTERN_INSTANCE_GUARD_ENABLED) {
			this.debugLogger.log(
				"🛡️ Instance Attribute Guard: Skipped (PATTERN_INSTANCE_GUARD_ENABLED is false)"
			);
			return;
		}

		this.debugLogger.log(
			"🛡️ Instance Attribute Guard: Starting..."
		);

		// Edit interception
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument((event) => {
				this.onDocumentChanged(event);
			})
		);

		// Active editor changes — apply decorations
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					this.evaluateAndDecorate(
						editor.document
					);
					this.applyDecorations(editor);
				}
			})
		);

		// Document open — determine guarded status
		this.disposables.push(
			vscode.workspace.onDidOpenTextDocument((document) => {
				this.evaluateAndDecorate(document);
			})
		);

		// Document save — re-evaluate from clean text (e.g. after GT export)
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument((document) => {
				this.evaluateGuardedStatus(document);
				this.buildProtectionCache(document);
				this.applyDecorationsForDocument(document);
			})
		);

		// Document close — clear cache
		this.disposables.push(
			vscode.workspace.onDidCloseTextDocument((document) => {
				const uri = document.uri.toString();
				this.protectionCache.delete(uri);
				this.guardedDocuments.delete(uri);
			})
		);

		// Already-open editors
		for (const editor of vscode.window.visibleTextEditors) {
			this.evaluateAndDecorate(editor.document);
			this.applyDecorations(editor);
		}

		this.debugLogger.log("🛡️ Instance Attribute Guard: Active");
	}

	// ───────────────────────────────────────────────
	// Guarded-file evaluation
	// ───────────────────────────────────────────────

	private evaluateAndDecorate(document: vscode.TextDocument): void {
		this.evaluateGuardedStatus(document);
		const uri = document.uri.toString();
		if (this.guardedDocuments.has(uri)) {
			this.buildProtectionCache(document);
			this.applyDecorationsForDocument(document);
		}
	}

	/**
	 * Evaluate once on open/save. NOT on every keystroke.
	 */
	private evaluateGuardedStatus(document: vscode.TextDocument): void {
		const uri = document.uri.toString();
		const filePath = document.uri.fsPath.replace(/\\/g, "/");

		if (!filePath.endsWith(".html")) {
			this.guardedDocuments.delete(uri);
			return;
		}
		if (!filePath.includes("/post-types/")) {
			this.guardedDocuments.delete(uri);
			return;
		}

		const text = document.getText();

		if (this.parseMetadataType(text) === "wp_block") {
			this.guardedDocuments.delete(uri);
			return;
		}

		// Guard is only relevant for phantom_blocks mode.
		// In template_loader / fields_only / other modes the instance slots are
		// either not present or freely editable, so protection is not needed.
		const displayMode = this.parseDisplayMode(text);
		if (displayMode !== "phantom_blocks") {
			this.guardedDocuments.delete(uri);
			return;
		}

		if (!text.includes("data-skylit-pattern-ref-id")) {
			this.guardedDocuments.delete(uri);
			return;
		}

		this.guardedDocuments.add(uri);
		this.debugLogger.log(
			`🛡️ Guard: File marked as guarded: ${filePath
				.split("/")
				.pop()}`
		);
	}

	private parseMetadataType(text: string): string | null {
		const match = text.match(
			/<!--\s*\n?\s*WordPress Sync Metadata\s*\n([\s\S]*?)-->/
		);
		if (!match) return null;

		for (const line of match[1].split("\n")) {
			const ci = line.indexOf(":");
			if (ci === -1) continue;
			if (
				line.substring(0, ci).trim().toLowerCase() ===
				"type"
			) {
				return line.substring(ci + 1).trim();
			}
		}
		return null;
	}

	private parseDisplayMode(text: string): string | null {
		const match = text.match(
			/<!--\s*\n?\s*WordPress Sync Metadata\s*\n([\s\S]*?)-->/
		);
		if (!match) return null;

		for (const line of match[1].split("\n")) {
			const ci = line.indexOf(":");
			if (ci === -1) continue;
			if (
				line.substring(0, ci).trim().toLowerCase().replace(/\s+/g, "") ===
				"displaymode"
			) {
				return line.substring(ci + 1).trim();
			}
		}
		return null;
	}

	// ───────────────────────────────────────────────
	// Protection cache — whole-tag ranges
	// ───────────────────────────────────────────────

	/**
	 * Build protection cache.
	 *
	 * Pattern instances are single self-closing tags with a JSON data attribute.
	 * The entire <section ...></section> is protected.
	 */
	private buildProtectionCache(document: vscode.TextDocument): void {
		const text = document.getText();
		const uri = document.uri.toString();
		const ranges: ProtectedRange[] = [];

		// Match entire <section data-skylit-pattern-ref-id="..."> ... </section>
		const sectionRegex =
			/<section\s+data-skylit-pattern-ref-id="[^"]*"[^>]*>[\s\S]*?<\/section>/gi;
		let sectionMatch: RegExpExecArray | null;

		while ((sectionMatch = sectionRegex.exec(text)) !== null) {
			ranges.push({
				start: sectionMatch.index,
				end: sectionMatch.index + sectionMatch[0].length,
				label: "pattern instance",
			});
		}

		this.protectionCache.set(uri, {
			version: document.version,
			ranges,
		});

		if (ranges.length > 0) {
			this.debugLogger.log(
				`🛡️ Guard: Cached ${
					ranges.length
				} protected range(s) in ${document.fileName
					.split("/")
					.pop()}`
			);
		}
	}

	// ───────────────────────────────────────────────
	// Edit interception
	// ───────────────────────────────────────────────

	private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
		if (this.isReverting) return;
		if (this.bypassGuard) return;

		const document = event.document;
		const uri = document.uri.toString();

		if (!this.guardedDocuments.has(uri)) return;

		// Only guard user/AI typing. External file changes (WordPress export,
		// git, sync, file watcher) must be accepted — GT is the authority
		// when it exports data. VS Code exposes TextDocumentChangeReason:
		//   1 = Undo, 2 = Redo, undefined = user typing or programmatic edit
		// External file writes (disk changes detected by VS Code) arrive as
		// a single change replacing the entire document content.
		const reason = (event as any).reason;
		if (reason === 1 || reason === 2) {
			// Undo/Redo — always allow, rebuild cache
			this.buildProtectionCache(document);
			this.applyDecorationsForDocument(document);
			return;
		}

		// Detect external file writes: a single change that replaces most/all
		// of the document is from an external source, not user typing.
		if (event.contentChanges.length === 1) {
			const change = event.contentChanges[0];
			const docText = document.getText();
			// External writes replace the full document (rangeLength ≈ old doc length)
			// or arrive as full-content set. User typing is always small and incremental.
			if (change.rangeLength > 100 && change.text.length > 100) {
				// Large replacement — accept as external write from GT export
				this.buildProtectionCache(document);
				this.applyDecorationsForDocument(document);
				return;
			}
		}

		let cache = this.protectionCache.get(uri);
		if (!cache) {
			this.buildProtectionCache(document);
			this.applyDecorationsForDocument(document);
			return;
		}

		// Check overlap with cached protected ranges (old-text offsets)
		// This only runs for small, incremental edits (user/AI typing)
		let needsRevert = false;

		for (const change of event.contentChanges) {
			const oldStart = change.rangeOffset;
			const oldEnd = change.rangeOffset + change.rangeLength;

			for (const pr of cache.ranges) {
				if (oldStart < pr.end && oldEnd > pr.start) {
					needsRevert = true;
					break;
				}
			}
			if (needsRevert) break;
		}

		if (needsRevert) {
			this.revertChanges(document);
			this.showProtectedWarning();
		} else {
			this.buildProtectionCache(document);
			this.applyDecorationsForDocument(document);
		}
	}

	private revertChanges(document: vscode.TextDocument): void {
		this.isReverting = true;

		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document === document) {
			vscode.commands.executeCommand("undo").then(
				() => {
					this.isReverting = false;
					this.buildProtectionCache(document);
					this.applyDecorationsForDocument(
						document
					);
				},
				() => {
					this.isReverting = false;
				}
			);
		} else {
			this.isReverting = false;
		}
	}

	private showProtectedWarning(): void {
		if (this.warningThrottleTimer) return;

		vscode.window.setStatusBarMessage(
			"$(lock) Pattern instance tag is read-only — only content between tags is editable",
			3000
		);

		this.debugLogger.log(
			"🛡️ Guard: Blocked edit to protected instance tag"
		);

		this.warningThrottleTimer = setTimeout(() => {
			this.warningThrottleTimer = null;
		}, 1000);
	}

	// ───────────────────────────────────────────────
	// Decorations
	// ───────────────────────────────────────────────

	private applyDecorations(editor: vscode.TextEditor): void {
		const uri = editor.document.uri.toString();

		if (!this.guardedDocuments.has(uri)) {
			editor.setDecorations(this.protectedDecorationType, []);
			return;
		}

		let cache = this.protectionCache.get(uri);
		if (!cache || cache.version !== editor.document.version) {
			this.buildProtectionCache(editor.document);
			cache = this.protectionCache.get(uri);
		}

		if (!cache || cache.ranges.length === 0) {
			editor.setDecorations(this.protectedDecorationType, []);
			return;
		}

		const decorations: vscode.DecorationOptions[] =
			cache.ranges.map((range) => ({
				range: new vscode.Range(
					editor.document.positionAt(range.start),
					editor.document.positionAt(range.end)
				),
				hoverMessage: new vscode.MarkdownString(
					"$(lock) **Pattern instance** — This tag is controlled by the pattern original. Only the content between tags is editable."
				),
			}));

		editor.setDecorations(
			this.protectedDecorationType,
			decorations
		);
	}

	private applyDecorationsForDocument(
		document: vscode.TextDocument
	): void {
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document === document) {
				this.applyDecorations(editor);
			}
		}
	}

	// ───────────────────────────────────────────────
	// Dispose
	// ───────────────────────────────────────────────

	public dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		this.protectionCache.clear();
		this.guardedDocuments.clear();
		this.protectedDecorationType.dispose();

		if (this.warningThrottleTimer) {
			clearTimeout(this.warningThrottleTimer);
			this.warningThrottleTimer = null;
		}

		this.debugLogger.log("🛡️ Instance Attribute Guard: Disposed");
	}
}
