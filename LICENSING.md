# Nest licensing

Nest's repository remains public. Camplight's policy for **new Camplight-owned
Nest code** is free use within the PolyForm Noncommercial License 1.0.0 and a
separate **paid commercial license** for uses outside those permissions.
This is source-available licensing, rather than OSI-approved open source.

The unmodified standard noncommercial terms are in [LICENSE](LICENSE). This page
identifies their scope and the transition from the existing Apache 2.0 releases;
it does not remove rights granted by other licenses.

## Scope and transition

The final pre-transition main revision is
[`9307fd2ee520d34375581744f65471b428cc8bc4`](https://github.com/camplight/nest/tree/9307fd2ee520d34375581744f65471b428cc8bc4).
That revision and earlier Apache-licensed Nest releases retain their Apache 2.0
grants, including commercial use. Existing rights are not revoked, and this
transition does not create a payment obligation for those versions.

| Material | Applicable terms |
| --- | --- |
| New Camplight-owned Nest code and modifications first released after the revision above | PolyForm Noncommercial 1.0.0, or a separate paid commercial agreement from Camplight. |
| Nest and inherited OrgOps portions already released under Apache 2.0 | Their existing Apache 2.0 rights remain. The original license is preserved in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt) and repository history. |
| Untouched engine in `vendor/orgops` | Its own [Apache 2.0 license](https://github.com/camplight/orgops/blob/3e3ed361cc8e6adc3ca352da56029d717d4b49bd/LICENSE) and [notice](https://github.com/camplight/orgops/blob/3e3ed361cc8e6adc3ca352da56029d717d4b49bd/NOTICE). Using OrgOps alone does not require a Nest commercial license. |
| SmoothUI adaptation | Its retained [MIT license](apps/user-ui/src/components/smooth-ui/LICENSE). |
| Connected-app logos | Their retained [license](apps/user-ui/public/integrations/LICENSE-logos.txt); third-party names and marks remain their owners' property. |
| Other dependencies and separately licensed files | Their own applicable licenses and notices. |

A modified file can contain both existing Apache-licensed portions and new
Camplight-owned modifications. The new terms apply to the latter; they do not
relicense the original portions. Attribution and third-party licenses must be
preserved when distributing Nest. The included texts are also copied into the
Docker image.

## Free uses and commercial licensing

The PolyForm text defines the permitted free uses. These include personal
noncommercial work and its listed charitable, educational, research, public-service
and government organization uses. Keep the license and required notices when
redistributing. The actual license text defines those exceptions.

For a company using new restricted Nest changes for commercial operations,
incorporating them into a commercial offering, or offering a paid hosted service,
obtain a separate paid written commercial agreement from Camplight before use,
unless another applicable license already permits that use.

Contact [Camplight](https://camplight.net/contact-us/) to discuss commercial terms. Pricing,
service commitments and the scope of permission are agreed separately. Cloning
the repository, creating an account or paying for unrelated services does not
itself create a commercial license. This change does not add a billing system,
license server or automatic license purchase.

## Contributions

Third-party authors retain their rights. This policy does not automatically grant
Camplight commercial relicensing rights over someone else's contribution.
Discuss licensing with the maintainers before submitting substantial new code
that would need to be offered under both licensing tracks. Existing contributions
and their existing licenses are preserved; no contributor agreement is implied.

## References

- [Official PolyForm Noncommercial 1.0.0 text](https://github.com/polyformproject/polyform-licenses/blob/1.0.0/PolyForm-Noncommercial-1.0.0.md).
- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), including existing grants and redistribution conditions.
- [Open Source Definition](https://opensource.org/osd), including commercial-use freedom.
