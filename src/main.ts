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

		if (!isFountain) {
			this.statusBarItem!.style.display = 'none';
			return;
		}

		const globPatterns = this.settings.fountainGlobPatterns;
		const files = this.app.vault.getMarkdownFiles();
		const fountainFiles = files.filter((f) =>
			micromatch.isMatch(f.path, globPatterns),
		);

		let total = 0;
		for (const file of fountainFiles) {
			const content = await this.app.vault.read(file);
			if (this.settings.useWordCount) {
				total += content.split(/\s+/).filter(Boolean).length;
			} else {
				total += content.split(/\r?\n/).length;
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

		containerEl.createEl('h2', { text: 'Fountain Note Glob Patterns' });

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
