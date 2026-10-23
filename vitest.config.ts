import { fileURLToPath } from "node:url";
import ts from "typescript";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [
        {
            name: "typescript-decorator-transform",
            enforce: "pre",
            transform(code, id) {
                if (!id.endsWith(".ts") || !/(?:^|\n)\s*@\w/m.test(code)) {
                    return null;
                }
                const output = ts.transpileModule(code, {
                    fileName: id,
                    compilerOptions: {
                        experimentalDecorators: true,
                        module: ts.ModuleKind.ESNext,
                        sourceMap: true,
                        target: ts.ScriptTarget.ESNext,
                    },
                });
                return {
                    code: output.outputText,
                    map: output.sourceMapText ? JSON.parse(output.sourceMapText) : null,
                };
            },
        },
    ],
    test: {
        include: ["test/**/*.test.ts"],
    },
    resolve: {
        alias: {
            "cbm-mcp": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
        },
    },
});
