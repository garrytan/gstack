# Plantpal: a watering coach for houseplants (synthetic fixture)

Made-up plan for test/first-use.test.ts. The owner, the app and every row are invented.

## Implementation plan

### Owner's words

- Ada Example, day 0: "I keep forgetting which plant needs water"

### Day one

| action | frequency | source | feature | route | first build | check |
|---|---|---|---|---|---|---|
| adds her first three plants by photo | once | owner words 1 | Add plant | home screen, plus button | build 1 | three plants show on the home screen with names |
| sees which plant needs water today | daily | owner words 1 | Today list | root screen | build 1 | the plant due today is at the top, marked due |
| marks a plant as watered | daily | owner words 1 | Watered button | Today list, tap a plant | build 1 | the plant drops off today's list |
| gets a reminder at 8am | daily | calendar habit | Morning reminder | notification | build 1 | a notification arrives at 8:00 on the device |
| opens a plant's care card | weekly | owner words 1 | Care card | home screen, tap a plant | build 1 | the card shows light, water and the last watered date |
| shares a plant with her partner | assumed | assumed | Sharing | plant card, share | build 2 | the partner's phone shows the plant |

### What it won't do yet

- No Android build
- No plant disease diagnosis
