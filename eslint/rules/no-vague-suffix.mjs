// A vague suffix names a category, not a behavior. The rule asks the diagnostic question the
// naming table pairs with each suffix rather than proposing a name: the answer is domain
// knowledge the rule does not have.

const SUFFIXES = [
  {
    suffix: "Manager",
    question: "What does managing mean here?",
    examples: "PaletteGenerator, SessionStore, PoolAllocator",
  },
  {
    suffix: "Handler",
    question: "Handling what event specifically?",
    examples: "AuthRequestHandler, WebhookProcessor",
  },
  {
    suffix: "Helper",
    question: "Is this a bag of unrelated functions?",
    examples: "split by domain: string.ts, date.ts",
  },
  {
    suffix: "Utils",
    question: "Is this a bag of unrelated functions?",
    examples: "split by domain: string.ts, date.ts",
  },
  {
    suffix: "Util",
    question: "Is this a bag of unrelated functions?",
    examples: "split by domain: string.ts, date.ts",
  },
  {
    suffix: "Service",
    question: "What service does it provide?",
    examples: "OrderPricingService, UserAuthService",
  },
];

// `Service` and `Handler` are not vague when a word in front of them answers the question:
// `OrderPricingService` names the service, `AuthRequestHandler` names the event. They are
// flagged only when nothing but these generic words precedes them.
const GENERIC_WORDS = new Set([
  "abstract",
  "app",
  "application",
  "base",
  "common",
  "core",
  "data",
  "default",
  "general",
  "generic",
  "global",
  "helper",
  "main",
  "manager",
  "misc",
  "shared",
  "util",
  "utils",
]);

// The naming table offers `AuthRequestHandler` as the answer to "handling what event?", so a
// handler whose last qualifier names an event has already answered it.
const EVENT_WORDS = new Set([
  "click",
  "command",
  "error",
  "event",
  "hook",
  "message",
  "request",
  "signal",
  "submit",
  "webhook",
]);

const QUALIFIED_SUFFIXES = new Set(["Service", "Handler"]);

function words(identifier) {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function isAnswered(suffix, qualifier) {
  if (!QUALIFIED_SUFFIXES.has(suffix)) return false;
  const qualifiers = words(qualifier);
  if (qualifiers.every((word) => GENERIC_WORDS.has(word))) return false;
  if (suffix === "Service") return true;
  return EVENT_WORDS.has(qualifiers.at(-1));
}

export function findVagueSuffix(name) {
  for (const entry of SUFFIXES) {
    // Case-sensitive on purpose: a bare lowercase `handler` is often a name a platform
    // requires (a serverless entry point), not one an author chose.
    if (!name.endsWith(entry.suffix)) continue;
    const qualifier = name.slice(0, name.length - entry.suffix.length);
    if (isAnswered(entry.suffix, qualifier)) return null;
    return entry;
  }
  return null;
}

function isExported(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    parent.type === "ExportNamedDeclaration" ||
    parent.type === "ExportDefaultDeclaration"
  ) {
    return true;
  }
  // `export const formatHelper = () => {}`: declarator -> declaration -> export.
  return (
    parent.type === "VariableDeclaration" &&
    parent.parent?.type === "ExportNamedDeclaration"
  );
}

function isFunctionInit(init) {
  return (
    init?.type === "ArrowFunctionExpression" ||
    init?.type === "FunctionExpression"
  );
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Naming standards: a type or exported function name ends in a vague suffix (Manager, Handler, Helper, Utils, or a Service that names no domain) — from CLAUDE.md §Naming Standards",
    },
    schema: [],
    messages: {
      vagueSuffix:
        "'{{name}}' ends in '{{suffix}}'. {{question}} Name the behavior instead ({{examples}}).",
    },
  },
  create(context) {
    function check(identifier) {
      if (!identifier || identifier.type !== "Identifier") return;
      const entry = findVagueSuffix(identifier.name);
      if (!entry) return;
      context.report({
        node: identifier,
        messageId: "vagueSuffix",
        data: {
          name: identifier.name,
          suffix: entry.suffix,
          question: entry.question,
          examples: entry.examples,
        },
      });
    }

    return {
      ClassDeclaration(node) {
        check(node.id);
      },
      ClassExpression(node) {
        check(node.id);
      },
      TSInterfaceDeclaration(node) {
        check(node.id);
      },
      TSTypeAliasDeclaration(node) {
        check(node.id);
      },
      FunctionDeclaration(node) {
        if (isExported(node)) check(node.id);
      },
      VariableDeclarator(node) {
        if (isExported(node) && isFunctionInit(node.init)) check(node.id);
      },
    };
  },
};
