import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

/** Adapt the pinned native model field without editing the installed package. */
export function nativeContextSettingsSource() {
  const require = createRequire(import.meta.url)
  const pkg = require('@deepseek-ai/dsh-client-ui-settings-models/package.json')
  if (pkg.version !== '0.2.2-rc.1')
    throw new Error('Unsupported native Models UI ' + pkg.version)
  const source = readFileSync(
    require.resolve('@deepseek-ai/dsh-client-ui-settings-models/client'),
    'utf8',
  )
  const ast = ts.createSourceFile(
    'native-models.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  const nodes = []
  const walk = (node) => {
    nodes.push(node)
    ts.forEachChild(node, walk)
  }
  walk(ast)
  const one = (matches, label) => {
    if (matches.length !== 1)
      throw new Error('Unsupported native Models UI: ' + label)
    return matches[0]
  }
  const factory = one(
    nodes.filter(
      (node) =>
        ts.isPropertyAssignment(node) &&
        node.name.getText(ast) === 'factory' &&
        ts.isArrowFunction(node.initializer) &&
        node.initializer.parameters[0]?.name.getText(ast) === 'require',
    ),
    'module factory',
  ).initializer
  const models = one(
    nodes.filter(
      (node) =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'ModelsSection',
    ),
    'ModelsSection',
  )
  const input = one(
    nodes.filter(
      (node) =>
        ts.isCallExpression(node) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === 'input' &&
        node.arguments[1] &&
        ts.isObjectLiteralExpression(node.arguments[1]) &&
        node.arguments[1].properties.some(
          (prop) =>
            ts.isPropertyAssignment(prop) &&
            prop.name.getText(ast) === 'value' &&
            prop.initializer.getText(ast) === 'props[field].value',
        ),
    ),
    'context capacity input',
  )
  let label = input.parent
  while (
    label &&
    !(
      ts.isCallExpression(label) &&
      label.arguments[0] &&
      ts.isStringLiteral(label.arguments[0]) &&
      label.arguments[0].text === 'label'
    )
  )
    label = label.parent
  if (!label) throw new Error('Unsupported native Models UI: capacity label')
  const eligible =
    'field === "contextWindow" && props.inputField === "input" && isGptModel(model)'
  const edits = [
    {
      start: input.getStart(ast),
      end: input.end,
      text:
        '(' +
        eligible +
        ' ? (0, react_jsx_runtime.jsx)(ContextWindowPreset, {' +
        'inputProps: ' +
        input.arguments[1].getText(ast) +
        ',' +
        'tokens: Number.isNaN(model[field]) ? NaN : parseCapacity(props[field].value),' +
        'onValueChange: props[field].onChange,' +
        'onCustomValueChange: (text) => {' +
        'props[field].onChange(text);' +
        'if (!validContextWindow(parseCapacity(text))) props.onFieldChange(field, NaN);' +
        '}' +
        '}) : ' +
        input.getText(ast) +
        ')',
    },
    {
      start: label.arguments[0].getStart(ast),
      end: label.arguments[0].end,
      text: '(' + eligible + ' ? "div" : "label")',
    },
  ]
  for (const statement of factory.body.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.left.getText(ast).startsWith('exports.')
    )
      edits.push({
        start: statement.getStart(ast),
        end: statement.end,
        text: '',
      })
  }
  const returns = factory.body.statements.filter(ts.isReturnStatement)
  const result = one(returns, 'factory return')
  edits.push({
    start: result.getStart(ast),
    end: result.end,
    text: 'return { ModelsSection, ModelListEditor, ProviderEditor, validateDeepSeekModels };',
  })
  const start = factory.body.getStart(ast) + 1
  let body = source.slice(start, factory.body.end - 1)
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.start < start || edit.end > factory.body.end)
      throw new Error('Native Models edit is outside the verified factory')
    body =
      body.slice(0, edit.start - start) +
      edit.text +
      body.slice(edit.end - start)
  }
  return { source, body, expectedModelsSectionSource: models.getText(ast) }
}
