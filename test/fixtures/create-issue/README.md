Fixtures for `create_issue` tests.

- `project-rossmannmerge.json`, `issue-priorities.json`: recorded 2026-11-03 from the live Redmine
  (`GET /projects/rossmannmerge.json?include=trackers,issue_custom_fields`, `GET /enumerations/issue_priorities.json`),
  trimmed to the fields the service reads.
- `created-issue.json`: synthetic `POST /issues.json` 201 body in the shape of a recorded issue.
- `custom-fields-admin.json`: synthetic `GET /custom_fields.json` body (admin-only endpoint; the recorded
  key gets 403), shaped after the Redmine REST docs.
