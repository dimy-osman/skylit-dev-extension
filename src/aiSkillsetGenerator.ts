/**
 * AI Skillset Generator
 *
 * Fetches system + custom skill files from WordPress and writes them to
 * .skylit/skillset/ in the dev folder. Triggered on connect and after
 * ACF JSON changes.
 */

import * as fs from "fs";
import * as path from "path";
import { RestClient } from "./restClient";
import { DebugLogger } from "./debugLogger";

export class AiSkillsetGenerator {
	private restClient: RestClient;
	private debugLogger: DebugLogger;
	private devPath: string;
	private generating = false;

	constructor(restClient: RestClient, debugLogger: DebugLogger, devPath: string) {
		this.restClient = restClient;
		this.debugLogger = debugLogger;
		this.devPath = devPath;
	}

	updateDevPath(devPath: string) {
		this.devPath = devPath;
	}

	private getSkillsetDir(): string {
		return path.join(this.devPath, ".skylit", "skillset");
	}

	private ensureDir(dir: string) {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	async generate(): Promise<void> {
		if (this.generating) {
			this.debugLogger.log("📚 Skillset generation already in progress, skipping");
			return;
		}
		if (!this.devPath) {
			this.debugLogger.log("📚 No dev path set, skipping skillset generation");
			return;
		}

		this.generating = true;

		try {
			this.debugLogger.log("📚 Fetching AI skillset files from WordPress...");

			const response = await this.restClient.getSkillsetFiles();

			if (!response.success || !response.files?.length) {
				this.debugLogger.log("📚 No skillset files returned");
				return;
			}

			const dir = this.getSkillsetDir();
			this.ensureDir(dir);

			let written = 0;
			for (const file of response.files) {
				const filePath = path.join(dir, file.filename);

				const existingContent = fs.existsSync(filePath)
					? fs.readFileSync(filePath, "utf-8")
					: null;

				if (existingContent !== file.content) {
					fs.writeFileSync(filePath, file.content, "utf-8");
					written++;
					this.debugLogger.log(`  ✅ Written: ${file.filename} (${file.type})`);
				}
			}

			if (written === 0) {
				this.debugLogger.log("📚 All skillset files up to date");
			} else {
				this.debugLogger.log(`📚 Skillset updated: ${written} file(s) written to ${dir}`);
			}
		} catch (error: any) {
			this.debugLogger.log(`📚 Skillset generation failed: ${error.message}`);
		} finally {
			this.generating = false;
		}
	}

	/**
	 * Delete the .sources-updated marker file after processing
	 */
	clearSourcesUpdatedMarker(): void {
		const markerPath = path.join(this.devPath, ".skylit", ".sources-updated");
		try {
			if (fs.existsSync(markerPath)) {
				fs.unlinkSync(markerPath);
				this.debugLogger.log("📚 Cleared .sources-updated marker");
			}
		} catch {
			// Marker may already be gone
		}
	}
}
