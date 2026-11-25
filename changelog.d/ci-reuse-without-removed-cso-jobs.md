### Changed

- **/ship can reuse a pull request's CI run without the three /cso CI jobs.** gstack's CI reuse rules no longer list `cso-macos-launcher`, `cso-windows-launcher` and `cso-docker-integration`, so the change that removes /cso, and with it those jobs, can count its own CI run. Nothing changes for anyone using gstack.
