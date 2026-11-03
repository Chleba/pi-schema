/**
 * Ask User Extension
 *
 * Registers an `ask_user` tool that lets the agent ask the user structured
 * clarifying questions mid-conversation — a set of questions, each with 2-4
 * answer options plus free text. Intended for the plan-preparation /
 * orchestration phase, but available in every session.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
	DynamicBorder,
	defineTool,
	type ExtensionAPI,
	getSelectListTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Input, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";

interface AskQuestion {
	question: string;
	options: string[];
}

type AskAnswers = { question: string; answer: string }[];

const MAX_QUESTIONS = 4;
const OTHER_ITEM_VALUE = "__other__";
const OTHER_ITEM_LABEL = "Other (type your own answer)";

function buildQuestionList(question: AskQuestion, listTheme: ReturnType<typeof getSelectListTheme>): SelectList {
	const items: SelectItem[] = question.options.map((option) => ({ value: option, label: option }));
	items.push({
		value: OTHER_ITEM_VALUE,
		label: OTHER_ITEM_LABEL,
		description: "Select this, then type a custom answer",
	});
	const maxVisible = Math.min(items.length, 6);
	const list = new SelectList(items, maxVisible, listTheme);
	return list;
}

function showAskDialog(
	tui: TUI,
	theme: Theme,
	questions: AskQuestion[],
	done: (answers: AskAnswers | undefined) => void,
): Component {
	const listTheme = getSelectListTheme();
	const border = (text: string) => theme.fg("accent", text);
	const topBorder = new DynamicBorder(border);
	const bottomBorder = new DynamicBorder(border);
	const answers: AskAnswers = [];
	let qIndex = 0;
	let mode: "list" | "input" = "list";
	let selectList = buildQuestionList(questions[0], listTheme);

	const input = new Input({ prompt: "> " });
	input.focused = true;
	input.onSubmit = (value) => {
		const trimmed = value.trim();
		if (!trimmed) return;
		recordAnswer(trimmed);
	};
	input.onEscape = () => {
		mode = "list";
		input.setValue("");
		tui.requestRender();
	};

	function recordAnswer(answer: string): void {
		answers.push({ question: questions[qIndex].question, answer });
		if (qIndex + 1 >= questions.length) {
			done(answers);
			return;
		}
		qIndex += 1;
		selectList = buildQuestionList(questions[qIndex], listTheme);
		wireList();
		mode = "list";
		tui.requestRender();
	}

	function wireList(): void {
		selectList.onSelect = (item) => {
			if (item.value === OTHER_ITEM_VALUE) {
				mode = "input";
				input.setValue("");
				tui.requestRender();
				return;
			}
			recordAnswer(item.value);
		};
		selectList.onCancel = () => done(undefined);
	}
	wireList();

	function headerLines(width: number): string[] {
		const counter = theme.fg("dim", `Question ${qIndex + 1} of ${questions.length}`);
		const counterText = new Text(counter, 1, 0);
		const questionText = new Text(theme.fg("accent", theme.bold(questions[qIndex].question)), 1, 0);
		const hint =
			mode === "list" ? "↑↓ navigate • enter select • esc cancel" : "enter submit answer • esc back to options";
		const hintText = new Text(theme.fg("dim", hint), 1, 0);
		return [...counterText.render(width), ...questionText.render(width), ...hintText.render(width)];
	}

	return {
		render: (width: number) => {
			const lines: string[] = [];
			lines.push(...topBorder.render(width));
			lines.push(...headerLines(width));
			if (mode === "list") {
				lines.push(...selectList.render(width));
			} else {
				lines.push(...input.render(width));
			}
			lines.push(...bottomBorder.render(width));
			return lines;
		},
		invalidate: () => {
			selectList.invalidate();
			input.invalidate();
		},
		handleInput: (data: string) => {
			if (mode === "list") {
				selectList.handleInput(data);
			} else {
				input.handleInput(data);
			}
			tui.requestRender();
		},
	};
}

function formatAnswers(answers: AskAnswers): string {
	const lines = answers.map((entry, index) => `${index + 1}. ${entry.question}\n   Answer: ${entry.answer}`);
	return `The user answered:\n\n${lines.join("\n")}`;
}

const askUserTool = defineTool({
	name: "ask_user",
	label: "Ask User",
	description:
		"Ask the user 1-4 clarifying questions, each with 2-4 concrete answer options plus free text. " +
		"Use this while preparing a plan or orchestrating work, when the answer changes what you build — " +
		"scope, approach, trade-offs the user should own, ambiguous requirements. " +
		"Do not use it for trivial confirmations or questions you can resolve from the codebase.",
	promptSnippet:
		"Ask the user structured clarifying questions (options + free text) via a dialog. Use before finalizing a plan when requirements are ambiguous.",
	promptGuidelines: [
		"Prefer asking one batched ask_user call with all blocking questions over guessing during plan preparation.",
		"Keep questions few and decision-relevant: each option should be a real choice, not filler.",
	],
	parameters: Type.Object({
		questions: Type.Array(
			Type.Object({
				question: Type.String({ description: "The question to ask the user." }),
				options: Type.Array(Type.String({ description: "A concrete answer option." }), {
					description: "2-4 concrete answer options. The user can always pick 'Other' and type their own answer.",
					minItems: 2,
					maxItems: 4,
				}),
			}),
			{
				description: "Questions to ask, answered one at a time.",
				minItems: 1,
				maxItems: MAX_QUESTIONS,
			},
		),
	}),

	async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<undefined>> {
		const questions = (params as { questions: AskQuestion[] }).questions;
		if (!ctx.hasUI || questions.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: "No interactive UI is available in this mode, so the user cannot answer. Continue with your best judgment and state your assumptions explicitly.",
					},
				],
				details: undefined,
			};
		}
		if (signal?.aborted) {
			return { content: [{ type: "text", text: "Cancelled before the questions were shown." }], details: undefined };
		}

		const answers = await ctx.ui.custom<AskAnswers | undefined>((tui, theme, _keybindings, done) =>
			showAskDialog(tui, theme, questions, done),
		);

		if (!answers) {
			return {
				content: [
					{
						type: "text",
						text: "The user dismissed the questions without answering. Proceed with your best judgment and state your assumptions explicitly.",
					},
				],
				details: undefined,
			};
		}
		return { content: [{ type: "text", text: formatAnswers(answers) }], details: undefined };
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(askUserTool);
}
