import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

test("installed Pi loader's message_subagent accepts strict-provider null budgets and rejects invalid calls", () => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/resume-sdk-"));
  try {
    // Load through Pi, not tsx: Pi aliases @sinclair/typebox to its own TypeBox version.
    const code = `
      const { loadExtensions } = await import(new URL("./core/extensions/loader.js",
        import.meta.resolve("@earendil-works/pi-coding-agent")));
      const { makeStrictJsonSchema } = await import(new URL("./api/constrained-sampling.js",
        import.meta.resolve("@earendil-works/pi-ai")));
      const { Check } = await import("typebox/value");
      const { validateToolArguments } = await import("@earendil-works/pi-ai");
      const loaded = await loadExtensions([${JSON.stringify(path.resolve("index.ts"))}], ${JSON.stringify(root)});
      if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
      if (loaded.extensions[0].tools.has("resume_subagents")) throw new Error("Legacy tool remains registered");
      const tool = loaded.extensions[0].tools.get("message_subagent").definition;
      const strictSchema = makeStrictJsonSchema(tool.parameters);
      const first = { name: "Margaret", message: "continue" };
      const second = { name: "Susan", message: "continue" };
      const strictCalls = [first, second].map(args => ({ ...args, name: [args.name], max_subagents_allowed: null }));
      if (!strictCalls.every((args) => Check(strictSchema, args))) throw new Error("Provider schema rejected null omissions");
      const prepare = args => {
        const snapshot = JSON.stringify(args);
        const value = tool.prepareArguments(args);
        if (JSON.stringify(args) !== snapshot) throw new Error("Preparation mutated recorded arguments");
        if (!Check(tool.parameters, value)) throw new Error("Prepared arguments do not satisfy registered schema");
        return value;
      };
      const prepared = [first, second, { ...first, max_subagents_allowed: 0 }].map(prepare);
      const strictErrors = [];
      const strictPrepared = strictCalls.map(args => {
        try { return prepare(args); } catch (error) { strictErrors.push(error.message); return null; }
      });
      const execute = async values => {
        const texts = [];
        for (const value of values.filter(Boolean)) {
          const validated = validateToolArguments(tool, { name: tool.name, arguments: value });
          const result = await tool.execute("sdk-message", validated, undefined, undefined, { cwd: ${JSON.stringify(root)} });
          texts.push(result.content[0].text);
        }
        return texts;
      };
      const executed = await execute(prepared);
      const strictExecuted = await execute(strictPrepared);
      const invalid = [];
      for (const bad of [
        { ...first, message: null }, { ...first, name: null }, { ...first, max_subagents_allowed: -1 },
        { ...first, intelligence: "senior" }, { ...first, intelligence: null }, { ...first, unknown: null },
        { name: "", message: "continue" }, { name: "Margaret", message: " " },
      ]) {
        for (const args of [{ resumes: [bad] }, { resumes: bad }, bad]) {
          let error;
          try { tool.prepareArguments(args); } catch (caught) { error = caught.message; }
          if (!error || error === "Assert") throw new Error("Invalid input was accepted or still returns bare Assert");
          invalid.push(error);
        }
      }
      console.log(JSON.stringify({ strictSchema, prepared, executed, invalid, strictPrepared, strictErrors, strictExecuted }));
    `;
    const output = JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", code], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...process.env,
          TMPDIR: root,
          JITI_CACHE_DIR: path.join(root, "jiti"),
          HOME: root,
          PI_CODING_AGENT_DIR: root,
          PI_SUBAGENT_NAMES_FILE: "",
          PI_SUBAGENT_BUDGET_DIR: "",
          PI_SUBAGENT_DEPTH: "0",
          DISABLE_RESUMABLE_SUBAGENTS: "false",
        },
      }),
    );
    const item = { name: ["Margaret"], message: "continue" };
    assert.deepEqual(output.prepared, [
      item,
      { name: ["Susan"], message: "continue" },
      { ...item, max_subagents_allowed: 0 },
    ]);
    const schema = output.strictSchema;
    assert.ok(schema.required.includes("max_subagents_allowed"), "strict mode requires optional keys");
    assert.ok(schema.properties.max_subagents_allowed.anyOf.some((type: { type: string }) => type.type === "null"));
    assert.equal(JSON.stringify(output.strictSchema).includes('"intelligence"'), false);
    assert.equal(output.executed.length, 3);
    assert.ok(
      output.executed.every((text: string) => text.startsWith("No subagent name registry")),
      "valid null-budget calls must get past preparation and SDK validation into the registered execute callback",
    );
    assert.equal(output.invalid.length, 24);
    assert.ok(output.invalid.every((error: string) => error.startsWith("Invalid tool arguments:")));
    assert.ok(output.invalid.some((error: string) => error.includes("intelligence")));
    assert.ok(output.invalid.some((error: string) => error.includes("/message")));
    assert.deepEqual(output.strictErrors, [], "strict-provider null allowances must mean omission");
    assert.deepEqual(output.strictPrepared, [item, { name: ["Susan"], message: "continue" }]);
    assert.equal(output.strictExecuted.length, 2);
    assert.ok(output.strictExecuted.every((text: string) => text.startsWith("No subagent name registry")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
