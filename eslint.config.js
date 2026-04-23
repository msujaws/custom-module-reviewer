import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import unicorn from "eslint-plugin-unicorn";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["node_modules/**", "output/**", ".cache/**", "dist/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: false,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      unicorn,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...unicorn.configs.all.rules,
      "unicorn/prevent-abbreviations": [
        "error",
        {
          allowList: {
            args: true,
            env: true,
            Env: true,
            props: true,
            params: true,
            Params: true,
            ref: true,
            refs: true,
            fn: true,
            Fn: true,
            i: true,
            j: true,
            utils: true,
            util: true,
            doc: true,
            dir: true,
            Dir: true,
            fetchFn: true,
            FetchFn: true,
            cacheDir: true,
            outDir: true,
            skillDir: true,
            outputDir: true,
            EnvSchema: true,
            loadEnv: true,
            ParsedEnv: true,
            MessagesCreateParams: true,
            bLen: true,
            aLen: true,
            opts: true,
            Doc: true,
            doc: true,
            MotsDoc: true,
            RawMotsDocSchema: true,
            motsDoc: true,
          },
        },
      ],
      "unicorn/no-null": "off",
      "unicorn/prefer-top-level-await": "off",
      "unicorn/no-process-exit": "off",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "unicorn/no-useless-undefined": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/no-array-callback-reference": "off",
    },
  },
  prettier,
];
