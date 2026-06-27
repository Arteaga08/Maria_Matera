import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/build/**", "**/node_modules/**", "**/.next/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Bilinguismo y limpieza: sin variables sin uso, salvo prefijo _
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // El estandar prohibe `as any`
      "@typescript-eslint/no-explicit-any": "error",
      // Sin console.log en produccion (permitimos warn/error para logs operativos)
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
);
