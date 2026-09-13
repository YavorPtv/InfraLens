import ts from "typescript";
import { getAwsSdkCommandMappings } from "./serviceMetadata";

export interface SourceCommandUse {
  action: string;
  matchedCommand: string;
  sdkPackage: string;
  importedSymbol: string;
  localSymbol: string;
  useLocation: { line: number; column: number };
  indexAccess?: { kind: "table" | "index" | "unknown"; indexName?: string };
}

export interface SourceSyntax {
  commands: SourceCommandUse[];
  imports: string[];
  limitations: string[];
}

// A closed, in-memory compiler host: no disk, package resolution or node_modules.
// The checker is used for lexical symbol identity, not type or runtime evaluation.
export function scanSourceSyntax(filePath: string, code: string): SourceSyntax {
  const result: SourceSyntax = { commands: [], imports: [], limitations: [] };
  if (!/\.(?:[cm]?js|jsx|tsx?)$/i.test(filePath)) {
    result.limitations.push("Only JavaScript/TypeScript source is supported.");
    return result;
  }
  const source = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true,
    /[jt]sx$/i.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const host: ts.CompilerHost = {
    getSourceFile: name => name === filePath ? source : undefined,
    getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => "",
    getDirectories: () => [], fileExists: name => name === filePath,
    readFile: name => name === filePath ? code : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n"
  };
  const program = ts.createProgram([filePath], { noLib: true, noResolve: true, allowJs: true, types: [] }, host);
  const checker = program.getTypeChecker();
  if (program.getSyntacticDiagnostics(source).length) result.limitations.push("Source has syntax errors; exact action narrowing requires review.");
  const bindings = new Map<ts.Symbol, { packageName: string; imported: string; namespace: boolean }>();
  const mappings = getAwsSdkCommandMappings();
  const warn = (message: string) => { if (!result.limitations.includes(message)) result.limitations.push(message); };
  const bind = (name: ts.Identifier, packageName: string, imported: string, namespace = false) => {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol && (symbol.declarations?.length ?? 0) !== 1) {
      warn("An import binding has conflicting declarations; its origin is ambiguous.");
      return;
    }
    if (symbol && packageName.startsWith("@aws-sdk/")) bindings.set(symbol, { packageName, imported, namespace });
  };
  const literalRequire = (node: ts.Node): string | undefined => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "require") return undefined;
    if (checker.getSymbolAtLocation(node.expression)?.declarations?.length) return undefined;
    return node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : undefined;
  };
  const visitImports = (node: ts.Node) => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) &&
        ["eval", "Function"].includes(node.expression.text) && !checker.getSymbolAtLocation(node.expression)?.declarations?.length) {
      warn("Dynamically generated code is not evaluated.");
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      const packageName = node.moduleSpecifier.text;
      const named = node.importClause?.namedBindings;
      const onlyNamedTypes = named && ts.isNamedImports(named) && named.elements.length > 0 &&
        named.elements.every(element => element.isTypeOnly) && !node.importClause?.name;
      if (!onlyNamedTypes) result.imports.push(packageName);
      if (named && ts.isNamedImports(named)) named.elements.forEach(element => {
        if (!element.isTypeOnly) bind(element.name, packageName, (element.propertyName ?? element.name).text);
      });
      if (named && ts.isNamespaceImport(named)) bind(named.name, packageName, "*", true);
      if (node.importClause?.name && packageName.startsWith("@aws-sdk/")) warn("Default AWS SDK imports are unsupported.");
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const onlyNamedTypes = node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(element => element.isTypeOnly);
      if (!onlyNamedTypes) result.imports.push(node.moduleSpecifier.text);
      if (node.moduleSpecifier.text.startsWith("@aws-sdk/")) warn("Re-exported AWS SDK commands require manual review.");
    }
    const required = literalRequire(node);
    if (required) result.imports.push(required);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const packageName = literalRequire(node.initializer);
      if (packageName) {
        if (ts.isIdentifier(node.name)) bind(node.name, packageName, "*", true);
        if (ts.isObjectBindingPattern(node.name)) node.name.elements.forEach(element => {
          if (ts.isIdentifier(element.name) && !element.dotDotDotToken && !element.initializer &&
              (!element.propertyName || ts.isIdentifier(element.propertyName))) {
            bind(element.name, packageName, (element.propertyName as ts.Identifier | undefined)?.text ?? element.name.text);
          }
        });
      }
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require" && !literalRequire(node)))) {
      warn("Dynamic imports or unresolved require calls are not evaluated.");
    }
    ts.forEachChild(node, visitImports);
  };
  visitImports(source);
  const mutated = new Set<ts.Symbol>();
  const visitWrites = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      let target: ts.Expression = node.left;
      while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) target = target.expression;
      const symbol = checker.getSymbolAtLocation(target);
      if (symbol && bindings.has(symbol)) { mutated.add(symbol); warn("An AWS SDK binding is reassigned or mutated."); }
    }
    ts.forEachChild(node, visitWrites);
  };
  visitWrites(source);
  const visitUses = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const expression = node.expression;
      const root = ts.isPropertyAccessExpression(expression) ? expression.expression : expression;
      const symbol = checker.getSymbolAtLocation(root);
      const binding = symbol ? bindings.get(symbol) : undefined;
      if (binding && !mutated.has(symbol!)) {
        const command = binding.namespace && ts.isPropertyAccessExpression(expression) ? expression.name.text : binding.imported;
        const metadata = mappings.find(mapping => mapping.commandName === command && mapping.packageName === binding.packageName);
        if (metadata && (!binding.namespace || ts.isPropertyAccessExpression(expression))) {
          const input = node.arguments?.[0];
          const properties = input && ts.isObjectLiteralExpression(input) ? input.properties : undefined;
          const names = properties?.flatMap(property => property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? [property.name.text] : []) ?? [];
          if (!properties || properties.some(property => ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name)))) {
            warn("Command input is opaque or computed; optional IAM actions and resource forms require review.");
          }
          if (["s3:GetObject", "s3:DeleteObject"].includes(metadata.action) && names.includes("VersionId")) {
            warn("Version-specific S3 operations require version actions; exact IAM inference is unavailable.");
            return;
          }
          if ((metadata.action === "s3:PutObject" && names.some(name => ["ACL", "Tagging", "GrantFullControl", "GrantRead", "GrantReadACP", "GrantWriteACP", "ObjectLockMode", "ObjectLockRetainUntilDate", "ObjectLockLegalHoldStatus"].includes(name))) ||
              (metadata.action === "ssm:PutParameter" && names.includes("Tags"))) {
            warn("Command options may require additional IAM actions not inferred here.");
          }
          if (metadata.action === "sns:Publish" && (!names.includes("TopicArn") || names.includes("PhoneNumber") || names.includes("TargetArn"))) {
            warn("SNS Publish target is not proven to be a topic; SMS/mobile endpoint resource semantics require review.");
          }
          const location = source.getLineAndCharacterOfPosition(node.getStart(source));
          result.commands.push({ action: metadata.action, matchedCommand: command, sdkPackage: binding.packageName,
            importedSymbol: command, localSymbol: expression.getText(source),
            useLocation: { line: location.line + 1, column: location.character + 1 },
            ...(["dynamodb:Query", "dynamodb:Scan"].includes(metadata.action) ? { indexAccess: indexAccess(node) } : {}) });
          if (metadata.action === "lambda:InvokeFunction") {
            // Qualifiers can also be embedded in a dynamic FunctionName.
            warn("Lambda invocation version/alias qualifiers and runtime FunctionName are not resolved.");
          }
        } else if (!command.endsWith("Client")) {
          warn(`Unsupported or dynamically selected AWS SDK command from ${binding.packageName}.`);
        }
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol && bindings.has(symbol)) warn("Computed AWS SDK member access is not evaluated.");
    }
    if (ts.isPropertyAccessExpression(node)) {
      const binding = bindings.get(checker.getSymbolAtLocation(node.expression)!);
      if (binding?.namespace && !node.name.text.endsWith("Client") &&
          !(ts.isNewExpression(node.parent) && node.parent.expression === node)) {
        warn("An AWS SDK namespace member is used indirectly; command selection requires review.");
      }
    }
    if (ts.isIdentifier(node)) {
      const binding = bindings.get(checker.getSymbolAtLocation(node)!);
      if (binding && !binding.namespace && !binding.imported.endsWith("Client") &&
          !ts.isImportSpecifier(node.parent) && !ts.isBindingElement(node.parent) &&
          !(ts.isNewExpression(node.parent) && node.parent.expression === node) &&
          !ts.isTypeReferenceNode(node.parent)) {
        warn("An AWS SDK command binding is used indirectly; dynamic command selection or wrappers require review.");
      }
    }
    ts.forEachChild(node, visitUses);
  };
  visitUses(source);
  return result;
}

function indexAccess(node: ts.NewExpression): NonNullable<SourceCommandUse["indexAccess"]> {
  const input = node.arguments?.[0];
  if (!input || !ts.isObjectLiteralExpression(input)) return { kind: "unknown" };
  if (input.properties.some(property => ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name)))) return { kind: "unknown" };
  const indexes = input.properties.filter(property => property.name &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "IndexName");
  if (!indexes.length) return { kind: "table" };
  if (indexes.length === 1 && ts.isPropertyAssignment(indexes[0]) && ts.isStringLiteral(indexes[0].initializer)) {
    return { kind: "index", indexName: indexes[0].initializer.text };
  }
  return { kind: "unknown" };
}
