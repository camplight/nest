# Wrapped agents and invitations

The invitation and wrapped-runtime protocol belongs to OrgOps. See the
[upstream guide](../vendor/orgops/docs/WRAPPED_AGENT_INVITES.md) and
[engine spec](../vendor/orgops/docs/SPEC.md).

Nest forwards invite endpoints through its authenticated API boundary. Existing
Nest wrapped bridges expect NEST_WRAPPED_* variables; the explicit
[offline migration](SUBMODULE_MIGRATION.md) adds aliases in their stored recipes.
New engine-native recipes may use ORGOPS_WRAPPED_* directly. The submodule itself
is never edited for a particular wrapper.
