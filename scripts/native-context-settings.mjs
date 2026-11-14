import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { supportedDshVersions } from './compat.mjs'

const styleNames = [
  'customized',
  'customizedSummary',
  'customizedBody',
  'rowHead',
  'rowName',
  'rowActions',
  'advancedHint',
  'field',
  'fieldLabel',
  'input',
  'editorActions',
  'error',
]

/** Adapt the pinned native model field without editing the installed package. */
export function nativeContextSettingsSource(
  packageName = '@deepseek-ai/dsh-client-ui-settings-models',
) {
  const require = createRequire(import.meta.url)
  const pkg = require(packageName + '/package.json')
  if (!supportedDshVersions.includes(pkg.version))
    throw new Error('Unsupported native Models UI ' + pkg.version)
  const source = readFileSync(require.resolve(packageName + '/client'), 'utf8')
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
        ts.isStringLiteralLike(node.arguments[0]) &&
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
      ts.isStringLiteralLike(label.arguments[0]) &&
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
  const styles = one(
    nodes.filter(
      (node) =>
        ts.isVariableDeclaration(node) &&
        node.name.getText(ast) === 'ModelsSection_module_css_default' &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer),
    ),
    'style map',
  ).initializer
  const settingsStyles = Object.fromEntries(
    styleNames.map((key) => {
      const property = one(
        styles.properties.filter(
          (node) =>
            ts.isPropertyAssignment(node) &&
            (ts.isStringLiteralLike(node.name) || ts.isIdentifier(node.name)) &&
            node.name.text === key &&
            ts.isStringLiteralLike(node.initializer),
        ),
        'style ' + key,
      )
      return [key, property.initializer.text]
    }),
  )
  return {
    version: pkg.version,
    source,
    body,
    settingsStyles,
    expectedModelsSectionSource: models.getText(ast),
  }
}
