import coreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * Flat config. eslint-config-next v16 ships native flat configs, so they are
 * imported directly rather than bridged through FlatCompat (which cannot
 * serialise the plugin graph and throws on a circular reference).
 */
const config = [
  ...coreWebVitals,
  ...nextTypescript,
  {
    ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts'],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Architectural boundary: the domain layer is pure. It may not reach into
    // data adapters, server-only modules, React, or Next. Anything it needs
    // from the outside world arrives as a function argument or a port interface.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/data/*', '@/server/*', '@/components/*', 'next/*', 'react'],
              message:
                'The domain layer must stay pure. Inject dependencies via ports instead of importing infrastructure.',
            },
          ],
        },
      ],
    },
  },
];

export default config;
