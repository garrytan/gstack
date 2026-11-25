### For contributors

- **A weekly benchmark record can no longer slip text into the release job's log through its error messages, or lose a model row to an odd model name.** When the release tool can't read a record, the reason it prints is now stripped of control characters too, and model names that collide once cleaned make the record unreadable instead of silently dropping a row.
