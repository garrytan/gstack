---
important: data-loss
---
**/land-and-deploy no longer leaves an auto-merge request behind or deletes `main`.** It merges the PR directly, pinned to the reviewed head. When GitHub won't allow the merge yet, or the base branch merges only through a merge queue, it says so and stops, instead of arming a merge that could land later with nobody watching. It deletes the head branch only when that branch lives in the repository, is not the default branch or `main`, and no other open PR uses it as its base, so a main-to-production promotion keeps `main` (#4770).
