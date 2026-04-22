---
name: newsletter
version: 1.0.0
description: |
  The Athletic newsletter creation workflow. Guides you through adding a new
  newsletter to both the Web (TypeScript) and PHP (the-athletic) repos. Handles
  interactive info gathering, Iterable configuration, all code changes across
  both repos, and test updates. Supports fast-track mode if one repo is already done.
  Use when asked to "add a new newsletter", "create a newsletter", or
  "create newsletter for [Name]".
triggers:
  - add a new newsletter
  - create a newsletter
  - create newsletter for
  - new newsletter
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
  - TaskCreate
  - TaskUpdate
  - TaskList
  - Skill
  - mcp__atlassian__getJiraIssue
---

# /newsletter — The Athletic Newsletter Creation Workflow

Creates a new newsletter across both the Web (TypeScript) and PHP repos. Both
repos require changes for a newsletter to be fully functional end-to-end.

Run this skill from the `/src` directory that contains both `web/` and
`the-athletic/` repos.

---

## Step 0: Prerequisites

### Repo check

Verify the expected repos are reachable:

```bash
ls -d web the-athletic 2>/dev/null || echo "REPOS_NOT_FOUND"
```

If `REPOS_NOT_FOUND`, stop and tell the user:

> Run this skill from the `/src` directory that contains both `web/` and `the-athletic/` subdirectories.

### Jira ticket

Use AskUserQuestion:

> What is the Jira ticket number for this newsletter? (e.g., ATL-1234)
> I'll use it to pre-populate the newsletter name and description.

Fetch the ticket using the Atlassian MCP:

- Tool: `mcp__atlassian__getJiraIssue`
- cloudId: `ec7d15d2-12b6-498e-95cc-b8c88e430f01`
- issueIdOrKey: the provided ticket number
- responseContentFormat: `markdown`

Extract from the ticket:

| Field               | Source                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Newsletter name** | `summary`, stripping boilerplate like "Add", "Create", "newsletter" (e.g., "Add Peak newsletter" → "Peak") |
| **Description**     | First substantive paragraph from the ticket body                                                           |
| **Jira ticket**     | Store for branch naming and commit messages                                                                |

If the ticket fetch fails or the user skips, continue without pre-populated values.

### Branch setup

Check the current branch in each repo:

```bash
git -C web branch --show-current
git -C the-athletic branch --show-current
```

Suggest a branch name based on the ticket and newsletter name:

```
{initials}/create-{newsletter-slug}-newsletter/{ticket-number}
```

For example: `kg/create-peak-newsletter/ATL-1234`

Tell the user:

> Please create and check out a branch in both repos before we continue.
> Suggested name: `{suggested_branch_name}`
>
> ```bash
> # In web/
> git -C web checkout develop && git pull origin develop && git checkout -b {branch_name}
>
> # In the-athletic/
> git -C the-athletic checkout develop && git pull origin develop && git checkout -b {branch_name}
> ```
>
> If a branch already exists, check it out instead:
>
> ```bash
> git -C web checkout {branch_name}
> git -C the-athletic checkout {branch_name}
> ```

Use AskUserQuestion to confirm: "Have you created/checked out the branch in both repos?"

- A) Yes, both repos are on the branch
- B) I'm only doing one repo — that's fine, continue

> **Note:** Do NOT run `git checkout`, `git checkout -b`, `git pull`, or `git push` yourself.

---

## Step 1: Route Selection

Use AskUserQuestion:

> Which phase are you starting from?

- A) Fresh start — set up both repos **(recommended)**
- B) Web repo is done — I have the config summary, just need PHP changes
- C) PHP repo is done — I have the config summary, just need Web changes

Set `MODE` to `full`, `php-only`, or `web-only` based on the answer.

---

## Step 2: Information Gathering

If a Jira ticket was fetched in Step 0, display the pre-populated values before
asking any questions:

```
Pre-populated from {TICKET}
============================
Name:        {name from ticket summary}
Description: {description from ticket body}
Slug:        {derived from name}
```

These values will be used as defaults throughout this step. The user only needs
to correct or extend them, not re-enter everything from scratch.

---

### Step 2a: Basic Information

> **Skip if MODE = `php-only`** — go directly to Step 2c.

Use AskUserQuestion:

> What is the newsletter name and slug?
>
> - Name (e.g., "The Pet", "Peak")
> - Slug (e.g., "the-pet", "peak") — I'll suggest one based on the name

Derive the slug from the name if not provided: lowercase, spaces to hyphens.

---

### Step 2b: Technical Identifiers

> **Skip if MODE = `php-only`**

Suggest values below based on the slug. Use AskUserQuestion to confirm or override:

| Identifier           | Suggested value                |
| -------------------- | ------------------------------ |
| Meta Key             | `_ath_{slug}_newsletter_on`    |
| Dynamo Key           | `{slug}_newsletter`            |
| Email Type           | `{slug}_newsletter_email`      |
| Newsletter ID        | `{slug}-newsletter`            |
| Registration Surface | `{slug}_sign_up`               |
| Analytics View       | `{slug}_newsletter_sign_up`    |
| Newsletter Constant  | `{SLUG_UPPERCASED}_NEWSLETTER` |

The Newsletter Constant becomes the PHP enum case name (e.g., `THE_PET_NEWSLETTER`).

---

### Step 2c: Iterable Configuration

Use AskUserQuestion:

> Provide the Iterable message type IDs for this newsletter:
>
> - Staging message type ID
> - Production message type ID
>
> (Find these in the Iterable dashboard under Message Types)

Then use AskUserQuestion:

> Provide Iterable list IDs (enter `null` if not needed):
>
> - Opt-in list ID — staging
> - Opt-in list ID — production (or same as staging)
> - Opt-out list ID — staging
> - Opt-out list ID — production (or same as staging)
>
> Many newsletters use the same ID for both environments. Opt-out is optional.

---

### Step 2d: Content & Display

> **Skip if MODE = `php-only`**

Use AskUserQuestion:

> Content and display details:
>
> - Description (shown on signup page and in email settings)
> - Title for signup page (defaults to newsletter name if the same)
> - Frequency and Time Description (usually the same as Frequency) - (e.g., "Once a week", "Daily", "Twice a week")
> - Sport type (e.g., "Peak", "NBA", "Int'l Soccer")
> - Success message (default: "We've added you to the roster!")

---

### Step 2e: Configuration

> **Skip if MODE = `php-only`**

Use AskUserQuestion:

> Onboarding and geo settings:
>
> - Show on onboarding? (default: yes)
> - Geo visibility: US only / CA only / All regions (US + CA + ROW)?
> - Priority position in onboarding list (e.g., "after Peak", "at the end")

Use AskUserQuestion:

> Optional features:
>
> - League mapping: should this newsletter auto-select when a user follows a league?
>   If yes, which league ID? (enter `none` to skip)
> - Custom lockup image widths? Most newsletters use defaults. (enter `no` to skip)

---

### Step 2f: Assets

> **Skip if MODE = `php-only`**

Use AskUserQuestion:

> Icon filename for onboarding (e.g., `peak-newsletter.svg`):
> I'll suggest `{slug}-newsletter.svg`

Check the next available index value:

```bash
grep -o "index: [0-9]*" web/src/features/welcome/utils/newsletters-metadata.ts | grep -oE "[0-9]+" | sort -n | tail -1
```

Use that max + 1 as the index.

Confirm that assets are uploaded:

> Assets must exist before the newsletter displays correctly:
>
> - `web/public/static/img/newsletter-images/{slug}-desktop.png` (or `.jpg`)
> - `web/public/static/img/newsletter-images/{slug}-mobile.png` (or `.jpg`)
> - `web/public/static/img/newsletter-images/{slug}-lockup.svg` (or `.png`)
> - `web/public/static/img/onboarding-images/{slug}-newsletter.svg` (if show_on_onboarding)
>
> Are all assets uploaded?

---

### Step 2g: Optional PHP Features

> **Skip if MODE = `web-only`**

Use AskUserQuestion:

> Is this a **popup newsletter**? Popup newsletters do not appear in email settings
> and don't show a legal-links section on their sign-up page.
> (Most newsletters are standard — answer "no" if unsure.)
>
> - A) No — standard newsletter (`show_legal_links: true`, `email_settings.page_enabled: true`)
> - B) Yes — popup newsletter (`show_legal_links: false`, `email_settings.page_enabled: false`)

Store the result as `IS_POPUP` (`true` / `false`). These values are needed for the
Step 5.8 StaticNewsletterRepository template.

Also record the current date in ISO 8601 format for the `created_at` / `updated_at` fields:

```bash
date -u +"%Y-%m-%dT%H:%M:%SZ"
```

Store the result as `{iso_date}`.

Use AskUserQuestion:

> Optional PHP-specific features:
>
> - Custom unsubscribe display name: should this newsletter show a custom name in
>   one-click unsubscribe messages? Most newsletters use auto-generated names.
>   (enter `none` to skip)
> - Special opt-in logic: any opt-in behavior beyond the standard newsletter signup
>   page flow? (enter `none` to skip)

## Step 3: Confirm and Create Task List

Display a full configuration summary for the user to review:

```
Newsletter Configuration
========================
Name:                   {name}
Slug:                   {slug}
Meta Key:               {meta_key}
Dynamo Key:             {dynamo_key}
Email Type:             {email_type}
Newsletter ID:          {newsletter_id}
Newsletter Constant:    {NEWSLETTER_CONSTANT}
Registration Surface:   {registration_surface}
Analytics View:         {analytics_view}

Iterable
========
Variable Name:              {slug}_newsletter_message_type_id
Message Type ID (stg / prod): {staging_message_type_id} / {production_message_type_id}
Opt-in  (stg / prd):        {optin_stg} / {optin_prd}
Opt-out (stg / prd):        {optout_stg} / {optout_prd}
```

Use AskUserQuestion: "Does this configuration look correct?"

- A) Yes, proceed with implementation
- B) No, I need to correct something

If B, ask what needs correcting and update before continuing.

Create a task list using TaskCreate to track progress. Mark each task `in_progress` before starting it and `completed` immediately after finishing. Omit Web tasks if MODE = `php-only`; omit PHP tasks if MODE = `web-only`; omit optional tasks that don't apply.

**Setup (always):**

- Gather configuration and confirm summary

**Web repo changes (skip if MODE = `php-only`):**

- 4.1 Update NEWSLETTERS constant
- 4.2 Update NEWSLETTERS_METADATA and regional priority arrays
- 4.3 Add newslettersMock entry
- 4.4 Update LEAGUE*TO_NEWSLETTER_MAP *(only if league mapping requested)\_
- 4.5 Add footer link _(only if a footer link is required)_
- 4.6 Add custom image widths _(only if custom widths requested)_

**PHP repo changes (skip if MODE = `web-only`):**

- 5.1 Update Email Type Enum
- 5.2 Update Newsletter Details (get_newsletter_details_from_name + newsletters_key_map)
- 5.3 Update Iterable API (property, init, valid_message_type_ids, get_subscription_post_data)
- 5.4 Update Newsletter Meta Key List
- 5.5 Update User Registration opt-in logic
- 5.6 Update Legacy User Creation (athUser)
- 5.7 Update One-click Unsubscribe
- 5.8 Update Static Newsletter Repository

**Tests:**

- 6.1 Update usePreselectedNewsletters tests _(Web — skip if MODE = `php-only`)_
- 6.2 Update NewsletterTest.php _(PHP — skip if MODE = `web-only`)_
- 6.3 Update AthUserRegistrationTest.php _(PHP — skip if MODE = `web-only`)_
- 6.4 Scan for other newsletter test arrays

**Verification and ship (always):**

- 7. Run TypeScript checks and PHP unit tests
- 8. Run /review in each repo
- 9. Create PRs via /ta-ship and print DynamoDB upsert mutation

---

## Step 4: Web Repo Implementation

> **Skip entirely if MODE = `php-only`**

Before making changes, read one existing newsletter entry in each file to understand
the current patterns and formatting.

---

### 4.1 NEWSLETTERS constant

Read `web/src/constants/newsletters.ts`.

Add in alphabetical order:

```typescript
NEWSLETTER_CONSTANT: '{slug}',
```

---

### 4.2 NEWSLETTERS_METADATA and priority arrays

Read `web/src/features/welcome/utils/newsletters-metadata.ts`.

Add to `NEWSLETTERS_METADATA` (alphabetical or end of newsletter block):

```typescript
[NEWSLETTERS.NEWSLETTER_CONSTANT]: {
  description: '{description}',
  email_type: '{email_type}',
  name: '{name}',
  meta_key: '{meta_key}',
  frequency: '{frequency}',
  icon: '{icon_filename}',
  index: {next_index},
  sport_type: '{sport_type}',
  title: '{title}',
  value: false,
},
```

Add to regional priority arrays at the specified position:

- `US_NEWSLETTERS_PRIORITY` — if geo includes US or all regions
- `CA_NEWSLETTERS_PRIORITY` — if geo includes CA or all regions
- `ROW_NEWSLETTERS_PRIORITY` — if geo includes all regions

---

### 4.3 newslettersMock

Read `web/src/features/newsletter/data-access/mock.ts`.

Add a complete mock entry following the exact structure of existing entries.
Include all fields: `newsletter_id`, `dynamo_key`, `meta_key`, `slug`,
`show_on_onboarding`, `frequency`, `metadata`, `sign_up_page`, `images`.

---

### 4.4 LEAGUE_TO_NEWSLETTER_MAP

> **Only if a league ID was provided.**

Read `web/src/features/welcome/utils/newsletters.ts`. Add:

```typescript
'{league_id}': NEWSLETTERS.NEWSLETTER_CONSTANT,
```

---

### 4.5 Footer

Read `web/src/components/footer/Footer.tsx`. Find the Newsletters section.

Add a `FooterSectionLink` maintaining alphabetical or priority order:

```tsx
<FooterSectionLink
  text={t("{name}")}
  href={transformDomain("/newsletters/{slug}/")}
/>
```

---

### 4.6 Custom Image Widths

> **Only if custom widths were specified.**

Read `web/src/features/newsletter/components/newsletter-template.tsx`.

Add to both `MobileLockupImageWidths` and `LockupImageWidths`:

```typescript
'{meta_key}': '{width}',
```

---

## Step 5: PHP Repo Implementation

> **Skip entirely if MODE = `web-only`**

Before making changes, read one existing newsletter entry in each file to understand
current patterns and formatting.

---

### 5.1 Email Type Enum

Read `the-athletic/web/app/themes/athletic/inc/class.athEmailType.inc.php`.

Add in alphabetical order among newsletter cases:

```php
case {NEWSLETTER_CONSTANT}_NEWSLETTER = '{email_type}';
```

---

### 5.2 Newsletter Details

Read `the-athletic/web/app/themes/athletic/inc/class.athNewsletterDetails.inc.php`.

Add to `get_newsletter_details_from_name()` switch statement:

```php
case "{slug}":
  $newsletter_details = (object) [
    "usermeta_key"         => "{meta_key}",
    "registration_surface" => "{registration_surface}",
    "email_type"           => AET::{NEWSLETTER_CONSTANT}_NEWSLETTER->value
  ];
  break;
```

Add to `newsletters_key_map()` array:

```php
AET::{NEWSLETTER_CONSTANT}_NEWSLETTER->value => (object)[
  "wordpress_usermeta_key" => "{meta_key}",
  "dynamo_key"             => "{dynamo_key}"
],
```

---

### 5.3 Iterable API

Read `the-athletic/web/app/themes/athletic/inc/class.iterableApi.inc.php`.

Add static property declaration:

```php
public static int ${slug}_newsletter_message_type_id;
```

Add initialization in `init()`:

```php
self::${slug}_newsletter_message_type_id = (!is_production() ? {staging_message_type_id} : {production_message_type_id});
```

Add to `valid_message_type_ids()` array:

```php
self::${slug}_newsletter_message_type_id,
```

Add to `$email_type_to_message_id` in `get_subscription_post_data_for_user()`:

```php
'{email_type}' => self::${slug}_newsletter_message_type_id,
```

---

### 5.4 Newsletter Meta Key List

Read `the-athletic/scripts/utils/newsletter_meta_key_list.php`.

If staging == production for both opt-in and opt-out:

```php
AET::{NEWSLETTER_CONSTANT}_NEWSLETTER->value => [
  'iterable_optin_list_id'  => {optin_id},   // null if not needed
  'iterable_optout_list_id' => {optout_id},  // null if not needed
],
```

If staging differs from production, use `is_production()` ternary:

```php
AET::{NEWSLETTER_CONSTANT}_NEWSLETTER->value => [
  'iterable_optin_list_id'  => is_production() ? {optin_prd}  : {optin_stg},
  'iterable_optout_list_id' => is_production() ? {optout_prd} : {optout_stg},
],
```

---

### 5.5 User Registration

Read `the-athletic/web/app/themes/athletic/inc/class.athUserRegistration.inc.php`.

Add to the `$optins` array in `get_newsletter_optin_values_for_new_user()`:

```php
AET::{NEWSLETTER_CONSTANT}_NEWSLETTER->value => $build_opt_payload($newsletter_page === '{slug}', $newsletter_page === '{slug}'),
```

---

### 5.6 Legacy User Creation

Read `the-athletic/web/app/themes/athletic/inc/class.athUser.inc.php`.

Add page detection variable (use underscores for the variable name):

```php
$is_from_{slug_underscored}_page = $newsletter_opt_in === "{slug}" || $reg_newsletter_opt_in === "{slug}";
```

Add to `$is_from_newsletter_signup_page` boolean expression:

```php
$is_from_newsletter_signup_page =
  // ... existing checks ...
  $is_from_{slug_underscored}_page;
```

Add opt-in/opt-out logic following the same pattern as existing newsletters:

```php
if ($is_from_{slug_underscored}_page) {
  update_user_meta($user_id, "{meta_key}", 1);
} else {
  update_user_meta($user_id, "{meta_key}", 0);
}
```

---

### 5.7 One-click Unsubscribe

Read `the-athletic/web/app/themes/athletic/page-email-unsubscribe.php`.

Add message type mapping (required for all newsletters):

```php
case iterableApi::${slug}_newsletter_message_type_id:
  $email_type = "{email_type}";
  break;
```

If a custom unsubscribe display name was provided, also add:

```php
case '{email_type}':
  $newsletter_name = "{custom_display_name}";
  break;
```

### 5.8 Static Newsletter Repository

Read `the-athletic/web/app/themes/athletic/inc/newsletters/class.StaticNewsletterRepository.inc.php`.

Scan the existing entries to find the correct insertion point (maintain the same
ordering used elsewhere — typically alphabetical by name, otherwise add at the end). Read one nearby entry to match formatting exactly.

Add the new entry:

```php
[
  'newsletter_id'        => '{newsletter_id}',  // must match mock.ts exactly; for popup newsletters, include the "-popup" suffix in the newsletter_id you set in Step 2b (e.g., "peak-popup-newsletter")
  'dynamo_key'           => '{dynamo_key}',
  'sport_type'           => '{sport_type}',
  'meta_key'             => '{meta_key}',
  'slug'                 => '{slug}',
  'show_on_onboarding'   => {show_on_onboarding},
  'frequency'            => '{frequency}',

  'metadata' => [
    'title'       => '{name} - Free Newsletter - The Athletic',
    'description' => '{description}',
  ],

  'sign_up_page' => [
    'show_legal_links' => {show_legal_links},  // false for popup newsletters
    'page_enabled'     => true,
    'title'            => '{sign_up_page_title}',
    'description'      => '{description}',
    'time'             => '{frequency}',
    'cookie_value'     => '{slug}',
    'success_message'  => "{success_message}",
    'analytics_view'   => '{analytics_view}',
  ],

  'images' => [
    'desktop'        => '/static/img/newsletter-images/{slug}-desktop.png',
    'mobile'         => '/static/img/newsletter-images/{slug}-mobile.png',
    'icon'           => '',  // populate if show_on_onboarding is true
    'lockup'         => '/static/img/newsletter-images/{slug}-lockup.png',
    'lockup_mobile'  => '',
  ],

  'email_settings' => [
    'title'        => '{name}',
    'description'  => '{description}',
    'index'        => {email_settings_index},
    'page_enabled' => {email_settings_page_enabled},  // false for popup newsletters
    'email_type'   => '{email_type}',
  ],

  'iterable' => [
    'message_type'            => (!is_production() ? {staging_message_type_id} : {prod_message_type_id}),
    'iterable_optin_list_id'  => (!is_production() ? {optin_stg} : {optin_prd}),
    'iterable_optout_list_id' => (!is_production() ? {optout_stg} : {optout_prd}),
  ],

  'leagueIds'   => [],
  'teamsIds'    => [],
  'created_at'  => '{iso_date}',
  'updated_at'  => '{iso_date}',
],
```

**Notes:**

- `newsletter_id` should match the `newsletter_id` used in `mock.ts` exactly
- `email_settings.index` should match the `index` used in `newsletters-metadata.ts`
- `email_settings.page_enabled` is `false` for popup newsletters (they don't appear in email settings UI)
- `sign_up_page.show_legal_links` is `false` for popup newsletters
- Use `(!is_production() ? {stg} : {prd})` ternaries only when staging and production values differ; use a bare integer when they are the same

---

## Step 6: Test Updates

### 6.1 Web: usePreselectedNewsletters tests

Read `web/src/features/welcome/hooks/__tests__/usePreselectedNewsletters.test.tsx`.

In every `describe` block:

- Add `'{slug}': false,` to all `getMappedValueToNewsletters` mock return values
- Add `'{slug}': false,` to all `getMappedLeaguesToNewsLetters` mock return values
- Add `NEWSLETTERS_METADATA[NEWSLETTERS.{NEWSLETTER_CONSTANT}]` to the appropriate
  result array (`suggestedResult`, `moreResult`, `preselectedResult`) matching the
  newsletter's position in the regional priority arrays

---

### 6.2 PHP: NewsletterTest

Read `the-athletic/tests/unit/NewsletterTest.php`.

Add to `getNewsletterSignUpCases()`:

```php
["{slug}", athUserNewsletterSources::NEWSLETTER_SIGNUP_PAGE->value],
```

---

### 6.3 PHP: AthUserRegistrationTest

Read `the-athletic/tests/unit/AthUserRegistrationTest.php`.

Add to `getValidateNewsletterOptInsCases()`:

```php
['{slug}', array_merge($base, [AET::{NEWSLETTER_CONSTANT}_NEWSLETTER->value => $this->buildExpected(1, true)])],
```

---

### 6.4 Scan for other newsletter test arrays

Search for any other test files that include newsletter slugs or email types in
arrays — add the new newsletter to all of them:

```bash
grep -rl "newsletter" the-athletic/tests/ --include="*.php"
grep -rl "newsletter" web/src --include="*.test.tsx" --include="*.test.ts"
```

For each file found, open it and verify the new newsletter's slug (or `{NEWSLETTER_CONSTANT}_NEWSLETTER` constant)
is present. If missing, add it following the same pattern as the entries immediately before or after where it
would appear alphabetically.

---

## Step 7: Verification

Run TypeScript checks:

```bash
cd web && yarn typecheck 2>&1 | tail -30
```

Run PHP unit tests:

```bash
cd the-athletic && ./vendor/bin/phpunit tests/unit/NewsletterTest.php tests/unit/AthUserRegistrationTest.php 2>&1 | tail -30
```

If either fails, investigate and fix before reporting done.

---

## Step 8: Completion Summary

Print all files changed and the configuration block for cross-repo reference:

```
Files modified
==============
Web repo:
  src/constants/newsletters.ts
  src/features/welcome/utils/newsletters-metadata.ts
  src/features/newsletter/data-access/mock.ts
  src/components/footer/Footer.tsx
  src/features/welcome/hooks/__tests__/usePreselectedNewsletters.test.tsx
  src/features/welcome/utils/newsletters.ts                              (if league mapping)
  src/features/newsletter/components/newsletter-template.tsx             (if custom widths)

PHP repo:
  web/app/themes/athletic/inc/class.athEmailType.inc.php
  web/app/themes/athletic/inc/class.athNewsletterDetails.inc.php
  web/app/themes/athletic/inc/class.iterableApi.inc.php
  scripts/utils/newsletter_meta_key_list.php
  web/app/themes/athletic/inc/class.athUserRegistration.inc.php
  web/app/themes/athletic/inc/class.athUser.inc.php
  web/app/themes/athletic/page-email-unsubscribe.php
  web/app/themes/athletic/inc/newsletters/class.StaticNewsletterRepository.inc.php
  tests/unit/NewsletterTest.php
  tests/unit/AthUserRegistrationTest.php

Newsletter Configuration Summary (for cross-repo reference)
============================================================
Newsletter Name:      {name}
Newsletter Slug:      {slug}
Meta Key:             {meta_key}
Email Type:           {email_type}
Dynamo Key:           {dynamo_key}
Newsletter Constant:  {NEWSLETTER_CONSTANT}_NEWSLETTER
```

If MODE=web-only, remind: "Web changes are complete. PHP repo changes still needed."
If MODE=php-only, remind: "PHP changes are complete. Web repo changes still needed."
If MODE=full, confirm: "Both repos are complete. Newsletter is ready to ship."

---

## Step 8.5: Review

Run `/review` in each repo before shipping:

```bash
git -C web diff origin/develop --stat
git -C the-athletic diff origin/develop --stat
```

Invoke the `/review` skill from each repo's directory context. If either review surfaces
critical issues, fix them before continuing to Step 9.

---

## Step 9: Ship PRs and DynamoDB

### 9.1 Create PRs via /ta-ship

Before running `/ta-ship`, use AskUserQuestion:

> All code changes are complete. Ready to create PRs?
>
> I'll run `/ta-ship` in both `web/` and `the-athletic/` to lint, commit, push,
> and open PRs. You can also do this yourself at any point by running `/ta-ship`
> from each repo directory.

Options:

- A) Yes, create PRs now (recommended)
- B) No, I'll run /ta-ship myself later

If B, skip to **Step 9.2** and just print the DynamoDB reminder.

If A, invoke the `/ta-ship` skill twice — once for each repo. Run `/ta-ship` from
the `web/` repo context, then again from the `the-athletic/` repo context. Pass
the Jira ticket number and newsletter name so the skill can pre-populate the PR
title and description.

After running /ta-ship (if you do), provide the user with urls to each PR

### 9.2 Upsert to DynamoDB via Apollo Playground

After the PRs are open, remind the user:

> The newsletter record also needs to be written to DynamoDB. Paste the following
> into Apollo Playground at https://studio.apollographql.com/graph/athletic-supergraph/variant/stg-nyt/explorer and run it after your branch is deployed. After it's pushed to prod, do the same in the `prd-nyt` playground

Print the mutation and variables populated with this newsletter's actual values:

**Mutation:**

```graphql
mutation UpsertNewsletter($newsletter_data: NewsletterInput!) {
  upsertNewsletter(newsletter_data: $newsletter_data) {
    newsletter_id
    slug
    dynamo_key
  }
}
```

**Variables** (populate all `{placeholders}` with this newsletter's config values;
`{leagueIds_json}` = `["{league_id}"]` if a league was mapped, or `[]` if not):

```json
{
  "newsletter_data": {
    "newsletter_id": "{newsletter_id}",
    "dynamo_key": "{dynamo_key}",
    "meta_key": "{meta_key}",
    "sport_type": "{sport_type}",
    "slug": "{slug}",
    "show_on_onboarding": {show_on_onboarding},
    "frequency": "{frequency}",
    "leagueIds": {leagueIds_json},
    "teamsIds": [],
    "created_at": "{created_at}",
    "updated_at": "{updated_at}",
    "metadata": {
      "title": "{metadata.title}",
      "description": "{metadata.description}"
    },
    "sign_up_page": {
      "page_enabled": {sign_up_page.page_enabled},
      "title": "{sign_up_page.title}",
      "description": "{sign_up_page.description}",
      "time": "{sign_up_page.time}",
      "cookie_value": "{sign_up_page.cookie_value}",
      "success_message": "{sign_up_page.success_message}",
      "analytics_view": "{sign_up_page.analytics_view}"
    },
    "images": {
      "desktop": "{images.desktop}",
      "mobile": "{images.mobile}",
      "icon": "{images.icon}",
      "lockup": "{images.lockup}",
      "lockup_mobile": "{images.lockup_mobile}"
    },
    "email_settings": {
      "page_enabled": {email_settings.page_enabled},
      "title": "{email_settings.title}",
      "description": "{email_settings.description}",
      "index": {email_settings.index},
      "email_type": "{email_type}"
    },
    "iterable": {
      "message_type": {iterable.message_type_prod},
      "iterable_optin_list_id": {iterable.optin_prd},
      "iterable_optout_list_id": {iterable.optout_prd}
    }
  }
}
```

> Note: `iterable.message_type` and the list IDs should use **production** values
> when running against the production Apollo endpoint, and **staging** values
> against staging. If `message_type` is still `0`, update it with the real
> Iterable message type ID before running.
