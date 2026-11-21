---
important: security
---
**The destructive-command check asks before two more kinds of delete outside the project.** A relative delete after `cd` into a system folder (`cd /etc/nginx && rm -f sites-enabled/default`) and removing a device node under `/dev` (`rm -f /dev/loop0`, also inside a loop) now ask, like their absolute-path forms already did. Deletes after a `cd` into `/tmp` or a project subfolder, `/dev/shm` files and output sent to `/dev/null` are unchanged.
