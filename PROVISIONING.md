# Inference Provisioning

## Current State

The gh-aw agent workflows use the Claude engine. Their generated workflow
definitions read `secrets.ANTHROPIC_API_KEY` for inference. This is a static
Anthropic API key owned by GitHub user [@cgwalters](https://github.com/cgwalters)
and stored as an organization secret available to the consumer repositories. The key
value must not be committed, logged,
or copied into workflow configuration.

The authored workflow sources are `.github/workflows/drafter.md`, `review.md`,
`fix.md`, `queue-triage.md`, and `ci-triage.md`; gh-aw compiles them into the
corresponding `.lock.yml` workflows that reference the secret.

## Target State

Inference should instead use workload identity federation (WIF) from GitHub
Actions to Red Hat's internal `bifrost-devel` GCP project. The workflow should
obtain short-lived credentials through that federation rather than receive a
long-lived Anthropic API key as an organization secret available to consumer repositories.

Exact WIF resource names, IAM grants, inference service, and endpoint are not
defined here and must be supplied by the owning platform team.

## Migration Outline

1. Agree on the supported inference integration and its gh-aw/workflow
   configuration for federated credentials.
2. Create the GitHub Actions OIDC trust and the required access in
   `bifrost-devel`, restricted to the intended consumer repositories and workflow
   identities.
3. Update the authored gh-aw workflow sources, then recompile their lock
   workflows. Do not edit generated lock files alone.
4. Test a non-production workflow run, including authentication, inference,
   failure handling, and log redaction.
5. Remove `ANTHROPIC_API_KEY` from workflow use, migrate every consumer repository,
   and then delete the organization secret after the federated path is verified.

## Prerequisites To Resolve

- The responsible team and approval process for resources in `bifrost-devel`.
- The approved inference service and gh-aw support for its authentication flow.
- The GitHub repository, branch, environment, and workflow-identity trust
  boundaries.
- Required permissions, credential lifetime, quota or billing ownership, and
  audit/logging requirements.
