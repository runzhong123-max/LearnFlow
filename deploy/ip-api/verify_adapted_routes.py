#!/usr/bin/env python3
"""Check actual `caddy adapt` JSON without loading it or opening a network port."""
import json
import sys

IP = "8.148.28.98"


def handles(value):
    if isinstance(value, dict):
        if "handler" in value:
            yield value
        for key, child in value.items():
            if key != "handle_response":
                yield from handles(child)
    elif isinstance(value, list):
        for item in value:
            yield from handles(item)


def verify(config):
    servers = config["apps"]["http"]["servers"].values()
    def ip_route(port):
        matches = [(server, route) for server in servers if f":{port}" in server.get("listen", [])
                   for route in server["routes"] if any(item.get("host") == [IP] for item in route.get("match", []))]
        assert len(matches) == 1, f"Expected exactly one IP route on {port}"
        return matches[0]
    server, https = ip_route(443)
    assert all(policy.get("default_sni") == IP for policy in server["tls_connection_policies"])
    proxies = [item for item in handles(https) if item["handler"] == "reverse_proxy"]
    assert len(proxies) == 3
    verifier, tutor, ordinary = proxies
    assert verifier["rewrite"] == {"method": "GET", "uri": "/api/auth/api-key/verify"}
    assert verifier["upstreams"] == [{"dial": "learnflow-backend:8010"}]
    assert verifier["handle_response"][0]["match"] == {"status_code": [2]}
    assert tutor["upstreams"] == [{"dial": "learnflow-frontend:4174"}]
    assert ordinary["upstreams"] == [{"dial": "learnflow-backend:8010"}]
    assert tutor["flush_interval"] == ordinary["flush_interval"] == -1
    outer = https["handle"][0]["routes"]
    api = next(route for route in outer if route.get("match") == [{"path": ["/api/*"]}])
    nested = api["handle"][0]["routes"]
    assert nested[1]["match"] == [{"path": ["/api/tutor*"]}]
    assert nested[1]["group"] == nested[2]["group"]
    assert list(handles(outer[-1]))[-1]["status_code"] == 404
    _, http = ip_route(80)
    entries = list(handles(http))
    assert not any(item["handler"] == "reverse_proxy" for item in entries)
    statuses = [item["status_code"] for item in entries if item["handler"] == "static_response"]
    assert statuses == [426, 404]
    assert any(item["handler"] == "file_server" for item in entries)
    routes = http["handle"][0]["routes"]
    assert routes[0]["match"] == [{"path": ["/.well-known/acme-challenge/*"]}]
    assert routes[1]["match"] == [{"path": ["/api", "/api/*"]}]
    certificates = config["apps"]["tls"]["certificates"]["load_files"]
    assert any(item["certificate"] == f"/etc/learnflow/ip-certificates/live/learnflow-ip-{IP}/fullchain.pem"
               and item["key"] == f"/etc/learnflow/ip-certificates/live/learnflow-ip-{IP}/privkey.pem" for item in certificates)


if __name__ == "__main__":
    with open(sys.argv[1]) as stream:
        verify(json.load(stream))
    print("IP API routing, API-key gate, no-SNI default and streaming checks passed")
