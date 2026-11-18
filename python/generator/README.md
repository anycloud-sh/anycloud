# Python SDK generator

The generator uses the pinned OpenAPI Generator 7.24.0 JAR and two pinned
template overrides. With `disallowAdditionalPropertiesIfNotPresent=false`, the
upstream `model_generic.mustache` both omits the `List` import used by closed
models, ignores explicit `additionalProperties: false` during Pydantic and
`from_dict` validation, and compares boolean enum values to lowercase strings.
The vendored template corrects those three behaviors. Its `from_dict` decoder
also preserves omitted fields through nested model conversion, so required
nullable values remain required and optional omissions remain unset.

The upstream `__init__package.mustache` is qualified with narrow public
`Client` and `AsyncClient` exports. Its generated exports are preserved. A module `__getattr__`
loads the corresponding `anycloud_workflows` class only when requested, avoiding
circular initialization and keeping raw API/model imports independent of
extensions. Explicit typing aliases and the extension's `py.typed` marker
preserve method types. Both exports appear in `__all__` and `dir(anycloud)`.

Keep these overrides aligned with upstream apart from the described changes.
Do not patch generated source or add another template without a fresh
qualification decision. The extension qualification checks fresh-process
import orders, class identity, annotations, and the single root bridge; model
qualification verifies that raw imports do not load extensions. Both run
against source and separately installed wheel and source distributions.

Run `yarn generate:python-sdk` from the repository root to recreate the ignored
`python/generated/anycloud` build input. The command generates twice in clean
temporary directories, compares both trees byte-for-byte, qualifies the Python
modules, and only then replaces the generated package.
