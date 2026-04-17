export type ComponentKind = "either" | "paired" | "selfClosing";
export type ComponentPropValueKind =
  | "boolean-attr"
  | "enum"
  | "freeform"
  | "number-like"
  | "path"
  | "path-or-url";

export interface ComponentSnippet {
  readonly label: string;
  readonly body: string;
  readonly description: string;
}

export interface ComponentPropMetadata {
  readonly type: "boolean" | "string";
  readonly valueKind: ComponentPropValueKind;
  readonly description: string;
  readonly values?: readonly string[];
}

export interface ComponentMetadata {
  readonly kind: ComponentKind;
  readonly file: string;
  readonly description: string;
  readonly snippets: readonly ComponentSnippet[];
  readonly props: Readonly<Record<string, ComponentPropMetadata>>;
}

export const COMPONENTS = {
  Audio: {
    kind: "either",
    file: "src/components/exam/Audio.astro",
    description: "插入音频播放器，可选标题。`src` 支持站内相对路径或完整 URL。",
    snippets: [
      {
        label: "Audio",
        body: 'Audio src="${1:https://attach.wiki.byrdocs.org/example.mp3}">\n\t${2:听力音频}\n</Audio>',
        description: "音频组件",
      },
    ],
    props: {
      src: {
        type: "string",
        valueKind: "path-or-url",
        description: "音频地址。相对路径会被解析到当前试题目录，或直接填写完整 URL。",
      },
    },
  },
  Blank: {
    kind: "either",
    file: "src/components/exam/Blank.astro",
    description: "填空题答案组件。带子节点时点击显示答案，自闭合时表示暂无答案。",
    snippets: [
      {
        label: "Blank",
        body: "Blank>${1:答案}</Blank>",
        description: "带答案的填空",
      },
    ],
    props: {},
  },
  Choices: {
    kind: "paired",
    file: "src/components/exam/Choices.astro",
    description:
      "选择题容器。内部可写 `<Option>`，也可用 `+` / `-` 无序列表简写选项。",
    snippets: [
      {
        label: "Choices",
        body: "Choices>\n\t$0\n</Choices>",
        description: "单选题容器",
      },
      {
        label: "Choices multiple",
        body: "Choices multiple>\n\t$0\n</Choices>",
        description: "多选题容器",
      },
    ],
    props: {
      item: {
        type: "string",
        valueKind: "number-like",
        description: "题号，用于多个空位或多组选项共享同一题面时标注题目编号。",
      },
      multiple: {
        type: "boolean",
        valueKind: "boolean-attr",
        description: "启用多选模式；缺省时为单选。",
      },
    },
  },
  Figure: {
    kind: "either",
    file: "src/components/exam/Figure.astro",
    description:
      "插入题图。`src` 通常填写当前试题目录中的相对文件名，可选旁置和背景色。",
    snippets: [
      {
        label: "Figure",
        body: 'Figure src="${1:题图1.svg}">\n\t${2:题图标题}\n</Figure>',
        description: "带标题的题图组件",
      },
      {
        label: "Figure float",
        body: 'Figure src="${1:题图1.svg}" float>\n\t${2:题图标题}\n</Figure>',
        description: "串文旁置题图组件",
      },
    ],
    props: {
      src: {
        type: "string",
        valueKind: "path",
        description: "图片文件名。试题页中应填写当前试题目录内的相对文件名。",
      },
      float: {
        type: "boolean",
        valueKind: "boolean-attr",
        description: "启用串文旁置布局。",
      },
      background: {
        type: "string",
        valueKind: "enum",
        values: ["white", "transparent"],
        description:
          "透明背景图片建议显式设置。常见值为 `white` 或 `transparent`，也可填写其他 CSS 颜色。",
      },
      alt: {
        type: "string",
        valueKind: "freeform",
        description: "可选替代文本；未填写时会根据标题或文件名推断。",
      },
    },
  },
  Option: {
    kind: "paired",
    file: "src/components/exam/Option.astro",
    description:
      "选择题选项组件。带 `correct` 表示正确答案；未标注时表示错误或未知。",
    snippets: [
      {
        label: "Option",
        body: "Option>${1:选项内容}</Option>",
        description: "普通选项",
      },
      {
        label: "Option correct",
        body: "Option correct>${1:正确选项}</Option>",
        description: "正确答案选项",
      },
    ],
    props: {
      correct: {
        type: "boolean",
        valueKind: "boolean-attr",
        description: "将当前选项标记为正确答案。",
      },
    },
  },
  Slot: {
    kind: "selfClosing",
    file: "src/components/exam/Slot.astro",
    description: "在题面中插入一个待选空位，可选 `item` 标注题号。",
    snippets: [
      {
        label: "Slot",
        body: "Slot />",
        description: "默认空位",
      },
      {
        label: "Slot item",
        body: 'Slot item="${1:1}" />',
        description: "带题号的空位",
      },
    ],
    props: {
      item: {
        type: "string",
        valueKind: "number-like",
        description: "题号，显示为 `(n)`。",
      },
    },
  },
  Solution: {
    kind: "paired",
    file: "src/components/exam/Solution.astro",
    description: "折叠显示答案或解析。没有答案时不应滥用此组件。",
    snippets: [
      {
        label: "Solution",
        body: "Solution>\n\t${1:答案或解析}\n</Solution>",
        description: "答案/解析折叠块",
      },
    ],
    props: {},
  },
} satisfies Readonly<Record<string, ComponentMetadata>>;

export type ComponentName = keyof typeof COMPONENTS;

export const COMPONENT_NAMES = Object.keys(COMPONENTS) as ComponentName[];

export function isComponentName(value: string): value is ComponentName {
  return value in COMPONENTS;
}

export const TERM_VALUES = ["1", "2"] as const;
export type TermValue = (typeof TERM_VALUES)[number];

export const TERM_LABELS: Readonly<Record<TermValue, string>> = {
  "1": "第一学期",
  "2": "第二学期",
};

export const STAGE_VALUES = ["期中", "期末"] as const;
export type StageValue = (typeof STAGE_VALUES)[number];

export const TYPE_VALUES = ["本科", "研究生"] as const;
export type ExamTypeValue = (typeof TYPE_VALUES)[number];

export const ANSWER_COMPLETENESS_VALUES = [
  "残缺",
  "完整",
  "完整可靠",
] as const;
export type AnswerCompletenessValue =
  (typeof ANSWER_COMPLETENESS_VALUES)[number];

export const DEFAULT_TEMPLATE_PATH = "templates/exam-page.mdx";
export const CONTENT_CONFIG_PATH = "src/content.config.ts";

export const MARKER_DOCS: Readonly<Record<"+" | "-", string>> = {
  "+": "在 `<Choices>` 中，`+` 列表项会被转换为 `<Option correct>`。",
  "-": "在 `<Choices>` 中，`-` 列表项会被转换为 `<Option>`。",
};
