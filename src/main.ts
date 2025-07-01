import { Prec } from '@codemirror/state';
import {
	App,
	FileView,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	type TFile,
} from 'obsidian';
import { fountainPlugin } from './editor/plugin.js';
import { onMetadataChanged, updateClass } from './tracker.js';
import { markdownPostProcessor } from './markdownPostProcessor';
import micromatch from 'micromatch';

interface FountainPluginSettings {
	useWordCount: boolean;
	lineCount: number;
	wordCount: number;
	fountainGlobPatterns: string[];
}

const DEFAULT_SETTINGS: FountainPluginSettings = {
	useWordCount: false,
	lineCount: 55,
	wordCount: 250,
	fountainGlobPatterns: [],
};

export default class FountainPlugin extends Plugin {
	settings: FountainPluginSettings;
	statusBarItem: HTMLElement | null = null;

	async onload() {
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.style.display = 'none';

		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);

		this.addSettingTab(new FountainSettingTab(this.app, this));

		this.registerEditorExtension(Prec.lowest(fountainPlugin));

		this.registerMarkdownPostProcessor((el, ctx) =>
			markdownPostProcessor(this, el, ctx),
		);

		// Ensure `fountain` class is added to relevant leaves
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				updateClass(this.app);
				this.updateStatusBar();
			}),
		);

		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				updateClass(this.app);
			}),
		);

		this.registerEvent(
			this.app.vault.on('modify', () => {
				this.updateStatusBar();
			}),
		);

		this.registerEvent(
			this.app.metadataCache.on('changed', (file: TFile) => {
				onMetadataChanged(this.app, file);
			}),
		);

		updateClass(this.app);

		await this.updateStatusBar();
	}

	onunload() {
		updateClass(this.app);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async updateStatusBar() {
		const view = this.app.workspace.getActiveViewOfType(FileView);
		const file = this.app.workspace.getActiveFile();
		let isFountain = false;

		if (view && file) {
			const meta = this.app.metadataCache.getFileCache(file);
			const cssClasses = meta?.frontmatter?.cssclasses ?? [];
			if (cssClasses.includes('fountain')) isFountain = true;
		}

		if (!isFountain || !file) {
			this.statusBarItem!.style.display = 'none';
			return;
		}

		const globPatterns = this.settings.fountainGlobPatterns;
		let matchedPattern: string | null = null;
		let matchedRoot: string | null = null;

		// Find the first pattern that matches the current file
		for (const pattern of globPatterns) {
			if (micromatch.isMatch(file.path, pattern)) {
				matchedPattern = pattern;
				// Try to extract the base folder from the pattern and file path
				// e.g. pattern: "Episodes/Episode*/**/*.md", file: "Episodes/Episode 1/scene1.md"
				// matchedBase: "Episodes/Episode 1"
				const patternParts = pattern.split('/');
				const fileParts = file.path.split('/');

				// Find the last non-wildcard pattern part (not *, **, or containing *)
				let lastNonWildcardIdx = -1;
				for (let i = 0; i < patternParts.length; i++) {
					const pat = patternParts[i];
					if (pat !== '**' && pat !== '*' && !pat.includes('*')) {
						lastNonWildcardIdx = i;
					}
				}

				// matchedRoot is the path up to and including the last non-wildcard part
				if (lastNonWildcardIdx >= 0) {
					matchedRoot = fileParts
						.slice(0, lastNonWildcardIdx + 1)
						.join('/');
				} else {
					// If no non-wildcard part, use the first part (e.g. "Episodes")
					matchedRoot = fileParts[0];
				}
				break;
			}
		}

		let filesToCount: TFile[] = [];
		if (matchedPattern && matchedRoot) {
			// Only count files that match the same pattern AND are under the same root as the current file
			filesToCount = this.app.vault
				.getMarkdownFiles()
				.filter(
					(f) =>
						micromatch.isMatch(f.path, matchedPattern!) &&
						(f.path === matchedRoot ||
							f.path.startsWith(matchedRoot + '/')),
				);
		} else {
			// If no pattern matches, only count the current file
			filesToCount = [file];
		}

		let total = 0;
		for (const file of filesToCount) {
			let content = await this.app.vault.read(file);

			// Remove frontmatter
			content = content.replace(/^---[\s\S]*?---\s*/m, '');

			// Remove Obsidian callouts (```ad-...``` blocks and > [!...] lines)
			content = content.replace(/```ad-[\s\S]*?```/g, '');
			content = content.replace(
				/^> \[!.*\][\s\S]*?(?=^$|^#|\n```|\n> \[!|\n-{3,}|$)/gm,
				'',
			);

			// Remove Markdown headings
			content = content.replace(/^#{1,6} .*/gm, '');

			// Remove Obsidian comments (%% ... %%)
			content = content.replace(/%%[\s\S]*?%%/g, '');

			// Remove code blocks (``` ... ```)
			content = content.replace(/```[\s\S]*?```/g, '');

			// Remove HTML comments
			content = content.replace(/<!--[\s\S]*?-->/g, '');

			// Remove empty lines
			content = content.replace(/^\s*$/gm, '');

			if (this.settings.useWordCount) {
				total += content.split(/\s+/).filter(Boolean).length;
			} else {
				total += content.split(/\r?\n/).filter(Boolean).length;
			}
		}

		let perPage = this.settings.useWordCount
			? this.settings.wordCount
			: this.settings.lineCount;

		const totalPages = total / perPage;
		const pages = Math.ceil(totalPages);
		const minutes = Math.floor(totalPages);
		const seconds = Math.round((totalPages - minutes) * 60);

		this.statusBarItem!.textContent = `${pages} pages (~${minutes.toString().padStart(2, '0')}:${seconds
			.toString()
			.padStart(2, '0')})`;
		this.statusBarItem!.style.display = '';
	}
}

class FountainSettingTab extends PluginSettingTab {
	plugin: FountainPlugin;

	constructor(app: App, plugin: FountainPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h1', { text: 'Fountain Plugin Settings' });

		containerEl.createEl('h2', { text: 'Count Settings' });

		new Setting(containerEl)
			.setName('Use Word Count')
			.setDesc('Use word count instead of line count in the status bar.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useWordCount)
					.onChange(async (value) => {
						this.plugin.settings.useWordCount = value;
						await this.plugin.saveSettings();
						this.plugin.updateStatusBar();
					}),
			);

		new Setting(containerEl)
			.setName('Line Count')
			.setDesc(
				'Number of lines per page for the Fountain script. Default is 55.',
			)
			.addText((text) =>
				text
					.setPlaceholder('e.g. 55')
					.setValue(this.plugin.settings.lineCount.toString())
					.onChange(async (value) => {
						const lineCount = parseInt(value.trim(), 10);
						if (!isNaN(lineCount) && lineCount > 0) {
							this.plugin.settings.lineCount = lineCount;
							await this.plugin.saveSettings();
							this.plugin.updateStatusBar();
						} else {
							new Notice('Please enter a valid line count.');
						}
					}),
			);

		new Setting(containerEl)
			.setName('Word Count')
			.setDesc(
				'Number of words per page for the Fountain script. Default is 250.',
			)
			.addText((text) =>
				text
					.setPlaceholder('e.g. 250')
					.setValue(this.plugin.settings.wordCount.toString())
					.onChange(async (value) => {
						const wordCount = parseInt(value.trim(), 10);
						if (!isNaN(wordCount) && wordCount > 0) {
							this.plugin.settings.wordCount = wordCount;
							await this.plugin.saveSettings();
							this.plugin.updateStatusBar();
						} else {
							new Notice('Please enter a valid word count.');
						}
					}),
			);

		containerEl.createEl('h2', { text: 'Glob Patterns' });
		containerEl.createEl('p', {
			text: `
				These patterns determine which files are counted in the status bar. Patterns are matched against the file paths.

				For example, "Scripts/**/*" will match all files in the Scripts folder and its subfolders.
				
				You can also use wildcards like "Episode*/**/*" to match all files in any folder starting with "Episode".
				Each parent "Episode" folder will be counted as a separate root.`,
		});

		this.plugin.settings.fountainGlobPatterns.forEach((pattern, idx) => {
			const setting = new Setting(containerEl)
				.setName(`Pattern ${idx + 1}`)
				.addText((text) =>
					text
						.setPlaceholder('e.g. Scripts/**/*')
						.setValue(pattern)
						.onChange(async (value) => {
							this.plugin.settings.fountainGlobPatterns[idx] =
								value.trim();
							await this.plugin.saveSettings();
							this.plugin.updateStatusBar();
						}),
				)
				.addExtraButton((btn) =>
					btn
						.setIcon('cross')
						.setTooltip('Remove')
						.onClick(async () => {
							this.plugin.settings.fountainGlobPatterns.splice(
								idx,
								1,
							);
							await this.plugin.saveSettings();
							this.display();
							this.plugin.updateStatusBar();
						}),
				);
		});

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText('Add pattern')
				.setCta()
				.onClick(async () => {
					this.plugin.settings.fountainGlobPatterns.push('');
					await this.plugin.saveSettings();
					this.display();
				}),
		);
	}
}
