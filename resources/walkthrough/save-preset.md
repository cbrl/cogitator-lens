# Save options as a preset

A preset keeps the extra compiler arguments and the options of one artifact kind, such as `-O2 -march=native` for assembly.

1. Open an artifact.
2. Set its options in the **Artifact Options** view.
3. Run **Save Current Options as Artifact Preset**, and type a name.

**Open Artifact** asks for a preset when a kind has more than one. The **Artifact Presets** view adds, edits, and deletes presets.

A key binding can open one kind with one preset:

```json
{
	"key": "ctrl+alt+o",
	"command": "coglens.OpenArtifact",
	"args": { "kind": "assembly", "preset": "default" }
}
```
