# Nest identity

Nest is the product layer around the pinned OrgOps submodule. Its UIs, CLI,
product API and settings use Nest identity. Engine source and package names
remain upstream OrgOps. There is no repository-wide source replacement step.

Compatibility lives at boundaries:

- Launchers map explicit `NEST_*` configuration to engine `ORGOPS_*` values.
- The HTTP/WS adapter translates Nest session cookies and runner headers.
- The offline migration adds environment aliases to existing wrapped recipes.
- The legacy engine database path and runner identity remain stable.

Branding is a product feature, persisted separately from the engine database.
An instance owner can configure its name, logo and colors under Admin → Branding.
The default is Nest; Camplight values are in `deploy/camplight-branding.json`.
Both interfaces retain the Nest footer.

Camplight logo source:
https://camplight.net/wp-content/uploads/2020/05/camplight-logo-horizontal-positive.svg
The sidebar asset keeps the coral mark and renders its wordmark in white.
Font licenses accompany the locally bundled Inter and Unbounded files.

See [migration instructions](SUBMODULE_MIGRATION.md) for existing deployments.
