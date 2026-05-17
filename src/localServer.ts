/**
 * Skylit Local WebSocket Server
 *
 * Binds to 127.0.0.1:<port> and broadcasts sync events directly to open
 * Gutenberg editor tabs, eliminating the need for PHP polling.
 *
 * Architecture:
 *   - Extension activates → starts server on first free port in [39595..39604]
 *   - PHP page loads → reads WS endpoint from transient written by extension
 *   - Browser connects → authenticates with per-session token
 *   - Browser subscribes to one or more postIds
 *   - On file-change / cursor-move / folder-action → broadcast to subscribers
 *
 * Remote-SSH: VS Code auto-forwards the port (portsAttributes in package.json)
 * so the browser always connects to 127.0.0.1 regardless of where the extension runs.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { WebSocket, WebSocketServer } from 'ws';

// ── Wire-protocol types ───────────────────────────────────────────────────────

/** Messages the browser sends to the server */
type C2SMessage =
	| { type: 'subscribe';        postId: number }
	| { type: 'unsubscribe';      postId: number }
	| { type: 'pong';             nonce: number }
	| { type: 'request-open-ide'; postId: number; line?: number; file?: string };

/** Messages the server sends to the browser */
export type S2CMessage =
	| { type: 'hello';        protocol: number; extensionVersion: string }
	| { type: 'ping';         nonce: number; serverTs: number }
	| { type: 'file-changed'; postId: number; files: string[]; hash: string; ts: number }
	| { type: 'cursor';       postId: number; blockId: string; ts: number }
	| { type: 'folder-action'; postId: number; action: 'trashed' | 'restored' | 'deleted' }
	| { type: 'error';        code: string; message: string };

// ── Constants ─────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION   = 1;
const PORT_RANGE_START   = 39595;
const PORT_RANGE_END     = 39604;
const PING_INTERVAL_MS   = 25_000;
const PONG_TIMEOUT_MS    = 10_000;
const REGISTER_INTERVAL  = 4 * 60_000; // re-register WS endpoint every 4 min
const TOKEN_TTL_MINUTES  = 10;         // server-side transient TTL on WP side

interface ClientState {
	ws:          WebSocket;
	subscribed:  Set<number>;
	pingSentAt:  number | null;
	pingNonce:   number | null;
	missedPings: number;
}

export class SkylitLocalServer {
	private wss:              WebSocketServer | null  = null;
	private httpServer:       http.Server | null       = null;
	private port:             number | null            = null;
	private sessionToken:     string                   = '';
	private clients:          Map<WebSocket, ClientState> = new Map();
	private pingTimer:        NodeJS.Timeout | null    = null;
	private registerTimer:    NodeJS.Timeout | null    = null;
	private siteUrl:          string                   = '';
	private extensionVersion: string                   = '';
	private registerEndpoint: ((port: number, token: string) => Promise<void>) | null = null;
	private outputChannel:    vscode.OutputChannel | null = null;

	constructor(
		extensionVersion: string,
		outputChannel?: vscode.OutputChannel,
	) {
		this.extensionVersion = extensionVersion;
		this.outputChannel    = outputChannel ?? null;
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────────

	/**
	 * Start the WS server. Returns the port it bound to, or null on failure.
	 *
	 * @param siteUrl           The WordPress site URL (used for Origin validation).
	 * @param registerEndpoint  Callback to POST the port+token to WP so it can
	 *                          inject WS config into the editor page.
	 */
	async start(
		siteUrl: string,
		registerEndpoint: (port: number, token: string) => Promise<void>,
	): Promise<number | null> {
		if (this.wss) return this.port;

		this.siteUrl          = siteUrl;
		this.registerEndpoint = registerEndpoint;
		this.sessionToken     = crypto.randomBytes(32).toString('hex');

		const port = await this.bindFreePort();
		if (port === null) {
			this.log('WS server: no free port in range — cannot start');
			return null;
		}

		this.port = port;
		this.log(`WS server started on port ${port}`);

		this.startPingTimer();
		await this.registerWithWP();
		this.registerTimer = setInterval(
			() => this.registerWithWP().catch(() => {}),
			REGISTER_INTERVAL,
		);

		return port;
	}

	/** Stop the server and clean up all resources. */
	stop(): void {
		if (this.pingTimer)     { clearInterval(this.pingTimer);     this.pingTimer     = null; }
		if (this.registerTimer) { clearInterval(this.registerTimer); this.registerTimer = null; }

		this.clients.forEach((_, ws) => ws.terminate());
		this.clients.clear();

		this.wss?.close();
		this.httpServer?.close();
		this.wss        = null;
		this.httpServer = null;
		this.port       = null;

		this.log('WS server stopped');
	}

	/** True if the server is currently running. */
	get isRunning(): boolean { return this.wss !== null; }

	/** The port the server is bound to, or null. */
	get boundPort(): number | null { return this.port; }

	// ── Broadcasting ───────────────────────────────────────────────────────────

	/** Notify all subscribers of postId that its files changed. */
	broadcastFileChanged(postId: number, files: string[], hash: string): void {
		this.broadcastToPost(postId, {
			type:   'file-changed',
			postId, files, hash,
			ts: Date.now(),
		});
	}

	/** Notify all subscribers that the cursor moved to blockId in postId. */
	broadcastCursor(postId: number, blockId: string, ts: number): void {
		this.broadcastToPost(postId, { type: 'cursor', postId, blockId, ts });
	}

	/** Notify all subscribers of a folder lifecycle event (trash / restore / delete). */
	broadcastFolderAction(
		postId: number,
		action: 'trashed' | 'restored' | 'deleted',
	): void {
		this.broadcastToPost(postId, { type: 'folder-action', postId, action });
	}

	// ── Private helpers ────────────────────────────────────────────────────────

	private async bindFreePort(): Promise<number | null> {
		for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
			const bound = await this.tryBind(port);
			if (bound) return port;
		}
		return null;
	}

	private tryBind(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const server = http.createServer();

			server.once('error', () => resolve(false));
			server.listen(port, '127.0.0.1', () => {
				const wss = new WebSocketServer({ server, path: '/skylit-ws' });

				wss.on('connection', (ws, req) => this.handleConnection(ws, req));

				this.httpServer = server;
				this.wss        = wss;
				resolve(true);
			});
		});
	}

	private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
		// ── Origin validation ──────────────────────────────────────────────────
		// Only accept connections from the configured WP site URL.
		// 127.0.0.1 is also accepted for local setups where WP runs on localhost.
		const origin = req.headers.origin ?? '';
		const allowed = this.isOriginAllowed(origin);
		if (!allowed) {
			this.log(`WS: rejected connection from origin "${origin}"`);
			ws.close(4003, 'Origin not allowed');
			return;
		}

		// ── Token validation ───────────────────────────────────────────────────
		const url    = new URL(req.url ?? '/', 'http://localhost');
		const token  = url.searchParams.get('token') ?? '';
		if (token !== this.sessionToken) {
			this.log('WS: rejected connection — invalid token');
			ws.close(4001, 'Invalid token');
			return;
		}

		const state: ClientState = {
			ws,
			subscribed:  new Set(),
			pingSentAt:  null,
			pingNonce:   null,
			missedPings: 0,
		};
		this.clients.set(ws, state);
		this.log(`WS: client connected (origin="${origin}")`);

		// Send hello
		this.send(ws, {
			type:             'hello',
			protocol:         PROTOCOL_VERSION,
			extensionVersion: this.extensionVersion,
		});

		ws.on('message', (raw) => {
			try {
				const msg = JSON.parse(raw.toString()) as C2SMessage;
				this.handleClientMessage(state, msg);
			} catch { /* ignore malformed messages */ }
		});

		ws.on('close', () => {
			this.clients.delete(ws);
			this.log('WS: client disconnected');
		});

		ws.on('error', () => {
			this.clients.delete(ws);
		});
	}

	private handleClientMessage(state: ClientState, msg: C2SMessage): void {
		switch (msg.type) {
			case 'subscribe':
				state.subscribed.add(msg.postId);
				break;
			case 'unsubscribe':
				state.subscribed.delete(msg.postId);
				break;
			case 'pong':
				if (msg.nonce === state.pingNonce) {
					state.pingSentAt  = null;
					state.pingNonce   = null;
					state.missedPings = 0;
				}
				break;
			case 'request-open-ide':
				// GT asks the extension to open a file/line — delegate to existing handler.
				// The extension wires this via onOpenIdeRequest in Phase 4.
				void Promise.resolve(vscode.commands.executeCommand('skylit._wsOpenIde', msg)).catch(() => {});
				break;
		}
	}

	private startPingTimer(): void {
		this.pingTimer = setInterval(() => {
			const now = Date.now();
			this.clients.forEach((state, ws) => {
				if (state.pingSentAt !== null) {
					// A ping is still outstanding.
					if (now - state.pingSentAt > PONG_TIMEOUT_MS) {
						state.missedPings++;
						if (state.missedPings >= 2) {
							this.log('WS: terminating unresponsive client');
							ws.terminate();
							return;
						}
					}
				}
				const nonce = Math.floor(Math.random() * 0xFFFFFF);
				state.pingNonce  = nonce;
				state.pingSentAt = now;
				this.send(ws, { type: 'ping', nonce, serverTs: now });
			});
		}, PING_INTERVAL_MS);
	}

	private async registerWithWP(): Promise<void> {
		if (!this.registerEndpoint || !this.port) return;
		try {
			await this.registerEndpoint(this.port, this.sessionToken);
			this.log(`WS: registered endpoint with WP (port ${this.port})`);
		} catch (err) {
			this.log('WS: failed to register with WP — ' + String(err));
		}
	}

	private isOriginAllowed(origin: string): boolean {
		if (!origin) return false;
		// Allow 127.0.0.1 / localhost always (local dev)
		if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true;
		// Match configured site URL (strip trailing slash)
		const site = this.siteUrl.replace(/\/$/, '');
		if (!site) return false;
		return origin === site || origin.startsWith(site + '/');
	}

	private broadcastToPost(postId: number, msg: S2CMessage): void {
		this.clients.forEach((state, ws) => {
			if (state.subscribed.has(postId)) {
				this.send(ws, msg);
			}
		});
	}

	private send(ws: WebSocket, msg: S2CMessage): void {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	}

	private log(msg: string): void {
		const line = `[Skylit WS] ${msg}`;
		if (this.outputChannel) {
			this.outputChannel.appendLine(line);
		}
		// Also surface in debug logger if available
		(globalThis as any).__skylitWsLog?.(line);
	}
}
