# instance-registry

Bookkeeping for instance lifecycles. See [the docs](https://example.com/docs) or
run `cargo doc --open`.

## Usage

1. Add the crate to `Cargo.toml`.
2. Create a registry and **insert** entries:

   ```rust
   let registry = Registry::new("vms");
   registry.insert(1, vm).await?;
   ```

3. Read them back with `get`.

> [!NOTE]
> The registry holds at most 4096 entries.

| State    | Terminal | Notes                  |
| -------- | -------- | ---------------------- |
| creating | no       | _initial_              |
| running  | no       | carries a timestamp    |
| failed   | yes      | ~~retried~~ not retried |

- [x] insert
- [ ] remove

---

Licensed under MPL-2.0. <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop.
