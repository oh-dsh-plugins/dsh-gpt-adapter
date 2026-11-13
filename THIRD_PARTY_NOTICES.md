# Third-party notices

The plugin uses the native adapter, model menu, and Models settings components
from the pinned `@deepseek-ai/dsh-llm-pi-ai`,
`@deepseek-ai/dsh-client-ui-model-selection`, and
`@deepseek-ai/dsh-client-ui-settings-models`, and `@deepseek-ai/dsh-mcp-client` version `0.2.2-rc.1` packages.
Original project: https://github.com/deepseek-ai/deepseek-harness

The build records native source hashes, reads native Models CSS class names,
and adapts the pinned native Models renderer to add a preset selector at the
original GPT context-window field. The runtime retains the original settings
entry, controller, child slots, and save/cancel operations, and restores its
renderer when unloaded. Other controls extend existing UI slots. MCP tool
filtering uses the pinned client's public tool-name encoding. Installed
third-party package files are never modified.

## DeepSeek Harness — MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
