import { readdirSync } from 'fs';
import { join, relative, resolve } from 'path';
import ts from 'typescript';

/**
 * RFC 0047 drift checks: the SDK operations Anycloud's API can send, read with
 * the type checker. Each member access, element access or destructured
 * property resolves to its declaration, so optional chains, narrowed types
 * and aliases all count. Casting an SDK value, passing it where any or
 * unknown is expected, or reaching the provider's API around the SDK throws.
 * A type lost some other way (a generic helper) is caught by name: reading a
 * known operation or operation group off an untyped value throws too. The
 * live run on a credential restricted to the published policy is the
 * backstop for anything else.
 */
export interface SdkPermissionScan {
  /** The provider's name for API calls in messages, such as `ARM`. */
  readonly label: string;
  /**
   * Matches an SDK declaration file's path, naming its package in a
   * `(?<package>…)` group, such as `/node_modules\/@azure\/(?<package>arm-[a-z]+)\//`.
   */
  readonly sdkPackage: RegExp;
  /** Module specifiers that must resolve, or the scan cannot see them. */
  readonly sdkImport: RegExp;
  /** Functions that build raw API requests, such as `armEndpoint`. */
  readonly endpointCalls: readonly string[];
  /** String fragments that name the API endpoint. */
  readonly endpointLiterals: readonly string[];
  /** Files allowed to use those calls and literals (client factories). */
  readonly endpointOwners: ReadonlySet<string>;
  /**
   * Functions whose first argument (or its array elements) the table relies
   * on, such as the namespaces a provider registration names. Each must be a
   * string literal.
   */
  readonly literalArguments?: readonly string[];
  /**
   * Operation and operation-group names too common to flag when read off an
   * untyped value, such as `get` or `list`.
   */
  readonly genericNames: ReadonlySet<string>;
}

export interface SdkScan {
  /** `<package>:<Group>.<member>` → the first file that sends it. */
  readonly operations: Map<string, string>;
  /** The `literalArguments` values passed anywhere. */
  readonly literals: Set<string>;
}

/** Every `.ts` file under a source directory. */
export function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts'))
    .map((path) => join(directory, path));
}

export function scanSdkOperations(
  config: SdkPermissionScan,
  rootNames: readonly string[],
  host?: ts.CompilerHost,
): SdkScan {
  if (!/\(\?<package>/.test(config.sdkPackage.source))
    throw new Error(
      'sdkPackage must capture the package name in (?<package>…)',
    );
  const program = ts.createProgram(
    rootNames,
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      resolveJsonModule: true,
    },
    host,
  );
  const checker = program.getTypeChecker();
  const sdkPackage = (symbol: ts.Symbol | undefined) => {
    const file = symbol?.declarations?.[0]?.getSourceFile().fileName;
    const match = file ? config.sdkPackage.exec(file) : null;
    if (match && !match.groups?.package)
      throw new Error(`sdkPackage matched ${file} without a package name`);
    return match?.groups?.package;
  };
  // Every SDK client or operation group the files use, and every member read
  // off an untyped value: a typed operation reached through any is caught by
  // name after the scan, however the type was lost on the way.
  const surfaces = new Set<ts.Type>();
  const untypedReads: { name: string; file: string }[] = [];
  const found = new Map<string, string>();
  const literals = new Set<string>();
  const roots = new Set(rootNames.map((name) => resolve(name)));
  for (const source of program.getSourceFiles()) {
    if (!roots.has(resolve(source.fileName))) continue;
    const file = relative('.', source.fileName);
    const owner = config.endpointOwners.has(file);
    const fail = (why: string): never => {
      throw new Error(
        `${file}: ${why}; call ${config.label} through typed SDK clients`,
      );
    };
    const record = (member: ts.Symbol | undefined, receiver?: ts.Type) => {
      if (!member || !callable(member)) return;
      const group = member.declarations?.[0]?.parent;
      const declared =
        group &&
        (ts.isInterfaceDeclaration(group) || ts.isClassDeclaration(group))
          ? group.name?.text
          : undefined;
      // A member is named by the SDK class or interface it is called on,
      // so an inherited method (sendRequest, getMetadata) keeps its caller.
      const receiverSymbol = receiver?.getSymbol();
      const receiverPkg = sdkPackage(receiverSymbol);
      const pkg = receiverPkg ?? sdkPackage(member);
      if (!pkg) return;
      const groupName = receiverPkg ? receiverSymbol!.name : declared;
      found.set(`${pkg}:${groupName}.${member.name}`, file);
    };
    // A client class or operation group, as opposed to a plain data model.
    const isSdkSurface = (type: ts.Type) => {
      const symbol = type.getSymbol();
      return (
        sdkPackage(symbol) !== undefined &&
        (Boolean(symbol!.flags & ts.SymbolFlags.Class) ||
          type
            .getProperties()
            .some((property) => callable(property) && sdkPackage(property)))
      );
    };
    // Contexts that drop the SDK's types: any, unknown, a union with one,
    // or an index signature of one.
    const ERASING = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
    const erases = (type: ts.Type | undefined): boolean =>
      type !== undefined &&
      (Boolean(type.flags & ERASING) ||
        (type.isUnion() && type.types.some(erases)) ||
        checker
          .getIndexInfosOfType(type)
          .some((info) => Boolean(info.type.flags & ERASING)));
    const callable = (member: ts.Symbol) =>
      // SDKs declare operations as methods or as callable properties.
      Boolean(member.flags & ts.SymbolFlags.Method) ||
      (Boolean(member.flags & ts.SymbolFlags.Property) &&
        checker.getTypeOfSymbol(member).getCallSignatures().length > 0);
    const receiverType = (expression: ts.Expression) =>
      checker.getNonNullableType(checker.getTypeAtLocation(expression));
    // A member read through a union receiver resolves to one declaration;
    // record the member of every client the receiver can be.
    const recordMember = (
      symbol: ts.Symbol | undefined,
      expression: ts.Expression,
    ) => {
      const receiver = receiverType(expression);
      if (!receiver.isUnion() || !symbol) return record(symbol, receiver);
      for (const type of receiver.types)
        record(type.getProperty(symbol.name), type);
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        config.sdkImport.test(node.moduleSpecifier.text) &&
        !checker.getSymbolAtLocation(node.moduleSpecifier)
      )
        fail(`cannot resolve ${node.moduleSpecifier.text}`);
      if (ts.isPropertyAccessExpression(node))
        recordMember(checker.getSymbolAtLocation(node.name), node.expression);
      if (ts.isElementAccessExpression(node))
        recordMember(
          checker.getSymbolAtLocation(node.argumentExpression),
          node.expression,
        );
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        const type = checker.getTypeAtLocation(node.parent);
        if (ts.isIdentifier(key)) record(type.getProperty(key.text), type);
      }
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : ts.isIdentifier(node.expression)
            ? node.expression.text
            : undefined;
        if (callee && config.literalArguments?.includes(callee)) {
          const [first] = node.arguments;
          for (const value of first && ts.isArrayLiteralExpression(first)
            ? first.elements
            : [first]) {
            if (!value || !ts.isStringLiteral(value))
              fail(`passes ${callee} a non-literal argument`);
            literals.add((value as ts.StringLiteral).text);
          }
        }
      }
      if (ts.isExpression(node)) {
        const type = checker.getTypeAtLocation(node);
        if (isSdkSurface(type)) {
          surfaces.add(type);
          if (erases(checker.getContextualType(node)))
            fail(`widens a typed ${config.label} SDK value to any`);
        }
      }
      if (
        (ts.isPropertyAccessExpression(node) ||
          (ts.isElementAccessExpression(node) &&
            ts.isStringLiteralLike(node.argumentExpression))) &&
        receiverType(node.expression).flags & ERASING
      )
        untypedReads.push({
          name: ts.isPropertyAccessExpression(node)
            ? node.name.text
            : (node.argumentExpression as ts.StringLiteralLike).text,
          file,
        });
      if (
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        sdkPackage(checker.getTypeAtLocation(node.expression).getSymbol())
      )
        fail(`casts a typed ${config.label} SDK value`);
      if (
        !owner &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        config.endpointCalls.includes(node.expression.text)
      )
        fail(`builds ${config.label} requests from ${node.expression.text}()`);
      if (
        !owner &&
        ts.isStringLiteralLike(node) &&
        config.endpointLiterals.some((literal) => node.text.includes(literal))
      )
        fail(`names the ${config.label} endpoint`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  // The operation groups and operations of every SDK surface the files use,
  // read from the SDK's own types, less the generic words.
  const named = new Set<string>();
  const names = (type: ts.Type, depth: number) => {
    for (const property of type.getProperties()) {
      const propertyType = checker.getTypeOfSymbol(property);
      const operation =
        Boolean(property.flags & ts.SymbolFlags.Method) ||
        propertyType.getCallSignatures().length > 0;
      if (operation && sdkPackage(property)) named.add(property.name);
      else if (depth > 0 && sdkPackage(propertyType.getSymbol())) {
        named.add(property.name);
        names(propertyType, depth - 1);
      }
    }
  };
  for (const type of surfaces) names(type, 1);
  for (const { name, file } of untypedReads)
    if (named.has(name) && !config.genericNames.has(name))
      throw new Error(
        `${file}: reaches a typed ${config.label} SDK operation through any (${name}); call ${config.label} through typed SDK clients`,
      );
  return { operations: found, literals };
}

/** The scan of one in-memory file at `path` inside the repository. */
export function scanSdkSnippet(
  config: SdkPermissionScan,
  text: string,
  path = 'src/api/drift-probe.ts',
): SdkScan {
  const name = resolve(path);
  const host = ts.createCompilerHost({});
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, version, ...rest) =>
    resolve(fileName) === name
      ? ts.createSourceFile(fileName, text, version)
      : getSourceFile(fileName, version, ...rest);
  const fileExists = host.fileExists;
  host.fileExists = (fileName) =>
    resolve(fileName) === name || fileExists(fileName);
  return scanSdkOperations(config, [name], host);
}

/** The permissions scanned operations need; an unmapped operation throws. */
export function permissionsFor(
  operations: Map<string, string>,
  mapping: Readonly<Record<string, readonly string[]>>,
  published: string,
): string[] {
  return [...operations].flatMap(([operation, file]) => {
    const permissions = mapping[operation];
    if (!permissions)
      throw new Error(
        `${file}: ${operation} has no permission mapping; add it to the scan's table and to ${published}`,
      );
    return [...permissions];
  });
}
