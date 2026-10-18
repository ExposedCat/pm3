# Registry selection

Register and start the project from the repository root:

```sh
cargo run -- create test-projects/registry-selection --name registry-selection
cargo run -- start registry-selection
```

Podman should ask which registry to use for `library/hello-world:latest`.
Select `docker.io/library/hello-world:latest`.

The selected short-name alias is persisted by Podman, so the prompt only
appears the first time this image name is pulled.
