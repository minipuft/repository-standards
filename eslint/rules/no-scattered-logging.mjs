// The wide-event doctrine: one structured event per unit of work, carrying that unit's
// context, instead of log lines scattered along the path. A console call is the scattered
// form. Files whose output IS console text (a CLI, a build script) opt out per file with a
// disable directive and a reason, which ESLint reports as unused once it stops being needed.

function resolvesToGlobal(sourceCode, node) {
  let scope = sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get("console");
    if (variable) return variable.defs.length === 0;
    scope = scope.upper;
  }
  return true;
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Wide-event logging: a console call is a scattered log line where one wide event per unit of work is wanted — from the wide-event-telemetry skill",
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allow: [] }],
    messages: {
      scatteredLog:
        "console.{{method}} writes a scattered log line. Emit one wide event per unit of work instead. A file whose output is console text (a CLI, a script) disables this rule for the file with a reason: /* eslint-disable fleet/no-scattered-logging -- <reason> */",
    },
  },
  create(context) {
    const [{ allow }] = context.options;
    const allowed = new Set(allow);
    const { sourceCode } = context;

    return {
      "CallExpression > MemberExpression.callee[object.type='Identifier'][object.name='console']"(
        node,
      ) {
        const method =
          node.property.type === "Identifier" && !node.computed
            ? node.property.name
            : sourceCode.getText(node.property);
        if (allowed.has(method)) return;
        if (!resolvesToGlobal(sourceCode, node)) return;
        context.report({ node, messageId: "scatteredLog", data: { method } });
      },
    };
  },
};
