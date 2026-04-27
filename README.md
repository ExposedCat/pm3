<h1 align="center">
  PM3 = PM2 + PodMan<br>
  <img style="width:512px" src="./assets/preview.png" alt="Screenshot">
</h1>

<div align="center">

<a href="https://coff.ee/exposedcat" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/default-orange.png" alt="Buy Me A Coffee" height="41" width="174"></a>

[![](https://img.shields.io/badge/me%20on-Telegram-informational?style=for-the-badge&logo=telegram&logoColor=26A5E4&color=26A5E4)](https://t.me/ExposedCatDev)
[![](https://img.shields.io/badge/me%20on-Reddit-informational?style=for-the-badge&logo=reddit&logoColor=FF5700&color=FF5700)](https://www.reddit.com/user/ExposedCatDev)

</div>

<br>

## Requirements

`pm3` operates on top of `podman` and `podman-compose`. Make sure to install it
whichever way.

## Examples

Create a project from a compose directory:

```sh
pm3 create ./apps/web --name website
```

Enable startup and start it right now, then admire the table:

```sh
pm3 enable website --now
pm3 list --detailed
```

Rebuild after you changed something suspicious:

```sh
pm3 restart website --build
```

Go full scorched-earth rebuild:

```sh
pm3 start website --no-cache
```

Clean up when the experiment has learned its lesson:

```sh
pm3 stop website
pm3 rm website
```

## Compose Notes

`pm3` does not invent a new orchestration religion. Keep using normal Compose
features like `depends_on`, `service_healthy`, and healthchecks.
Project-specific extras are planned under `x-pm3` for hooks, timeouts, failure
limits, and reporting.
