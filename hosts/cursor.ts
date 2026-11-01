import { defineHost } from './define-host';

const cursor = defineHost({
  name: 'cursor',
  displayName: 'Cursor',

  frontmatter: {
    mode: 'allowlist',
    keepFields: ['name', 'description'],
    descriptionLimit: null,
    conditionalFields: [
      { if: { manual_only: true }, add: { 'disable-model-invocation': true } },
    ],
  },
});

export default cursor;
