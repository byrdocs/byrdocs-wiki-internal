# BYR Docs Wiki Tools

`BYR Docs Wiki Tools` 是一个专门为 [`byrdocs-wiki-internal`](https://github.com/byrdocs/byrdocs-wiki-internal) 仓库编写的 VS Code 扩展，用来优化 Astro / MDX 试题页面的编辑、预览和创建流程。

它不是通用扩展。只有当前工作区根目录的 `package.json` 中 `name` 为 `byrdocs-wiki` 时，扩展功能才会启用。

## 快速开始

### 预览试题页面

打开一个 `exams/<name>/index.mdx` 文件，然后执行以下任一操作：

- 按 `Ctrl/Cmd + K V`
- 点击编辑器右上角的预览按钮
- 在命令面板执行 `BYR Docs Wiki: 预览试题页面`

### 新建试题页面

点击左侧 Activity Bar 中的 `BYR Docs Wiki` 图标，填写表单后提交即可。

### 切换选择题正误

在 `<Choices>` 中，单击 `Option` 或 `+` / `-` 选项旁的 inlay hint，即可直接切换正误状态。


## 功能

### 组件编辑增强

面向 `*.astro` 和 `*.mdx` 文件提供仓库定制能力：

- 自定义组件开始标签、结束标签补全
- 组件属性名、属性值补全
- `Figure`、`Audio` 等相对路径自动补全
- 组件 hover 说明
- `Ctrl` / `Cmd` + 点击跳转到组件实现
- 自定义组件基础折叠
- 组件与属性的语义高亮

针对题目选择题语法还提供了额外支持：

- 识别 `<Choices>`、`<Option>`、`+` / `-` 选项语法
- 在选项前显示正误状态 inlay hint
- Ctrl/Cmd + 单击 inlay hint 可直接切换正误

额外诊断：

- `Figure src` 引用的相对文件不存在时，显示 `Error`

### 试题页面预览

对于 `exams/<name>/index.mdx`，扩展提供内置预览。

支持以下触发方式：

- 命令面板：`BYR Docs Wiki: 预览试题页面`
- 编辑器右上角按钮
- 编辑器右键菜单
- 资源管理器右键菜单
- 快捷键 `Ctrl/Cmd + K V`

触发预览后，扩展会：

1. 在终端中运行 `pnpm i && pnpm dev`
2. 从终端输出中解析开发服务器地址
3. 在编辑器内打开内置 WebView 预览
4. 自动跳转到当前试题页面对应的站点路径

### 新建试题页面

扩展会在左侧 Activity Bar 中注册专用视图 `BYR Docs Wiki`。

你可以在其中填写：

- 开始年份、结束年份
- 学期
- 课程名称
- 阶段
- 类型
- 学院
- 来源
- 答案完成度
- 备注

扩展会自动：

- 校验常见规则，例如结束年份必须等于开始年份 `+ 1`
- 按仓库命名规则创建 `exams/<name>/index.mdx`
- 读取仓库根目录 `templates/exam-page.mdx`
- 写入基础模板与 frontmatter
- 创建后自动打开预览

## 适用范围

本扩展主要面向以下文件：

- `exams/<name>/index.mdx`
- `src/others/guide.mdx`
- `src/others/test.mdx`
- `*.astro`
