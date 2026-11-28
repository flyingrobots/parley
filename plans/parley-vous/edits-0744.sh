cp dag.json dag.v1.json && jq '
  .nodes.D.depends_on = ["C"]
  | .nodes.M4 = {"title":"parley-vous (PyPI) reads receipts: the read API, ported from the TypeScript reader","type":"feature","size_hours":1,"depends_on":["M2"]}
  | .nodes.N3 = {"title":"parley-vous (crate) writes Parley-vous output: the write API","type":"feature","size_hours":1,"depends_on":["N"]}
  | .nodes.N4 = {"title":"parley-vous (crate) reads receipts: the read API","type":"feature","size_hours":1,"depends_on":["N"]}
  | .nodes.R = {"title":"The parley-vous CLI (Rust, on the crate) queries history, opens records and checks a captured run (existing parley#138, rewritten)","type":"feature","size_hours":1,"depends_on":["N4"]}
  | .nodes.X = {"title":"A language-agnostic conformance corpus (bash + bats) runs against every parley-vous package","type":"feature","size_hours":1,"depends_on":["L2","M2","N"]}
  | .nodes.N2.depends_on = ["N3","N4"]
  | .nodes.M3.depends_on = ["M2","M4"]
  | .nodes.P.depends_on = ["L3","M3","N2","O","X","R"]
  | .nodes.K.depends_on = ["P"]
  | .nodes.Q.depends_on = ["P"]
  | .nodes |= with_entries(.value.size_hours = 1)
' dag.v1.json > dag.json && out=$(python3 ~/.agents/skills/taskalisk/scripts/taskalisk.py --verify-dag dag.json 2>err.jsonl); echo "exit $?"; printf '%s\n' "$out" | jq -c 'select(._schema.id=="taskalisk.plan") | {ok, tasks: (.metrics.open_node_count // null), frontier, critical_path: .metrics.critical_path, width: .metrics.max_parallel_width, density: .metrics.edge_density, isolated: .metrics.isolated_open_nodes}'; printf '%s\n' "$out" | jq -r 'select(._schema.id=="taskalisk.finding") | "\(.code): \(.message // "")"'; jq -r .code err.jsonl 2>/dev/null; jq '.nodes|length' dag.json

# ----
jq '.nodes.M3.depends_on = ["M4"]' dag.json > d2 && mv d2 dag.json && python3 ~/.agents/skills/taskalisk/scripts/taskalisk.py --verify-dag dag.json 2>/dev/null | jq -c 'select(._schema.id=="taskalisk.plan" or ._schema.id=="taskalisk.finding") | if ._schema.id=="taskalisk.plan" then {ok, critical_path: .metrics.critical_path, width: .metrics.max_parallel_width} else .code end'