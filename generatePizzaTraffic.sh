#!/usr/bin/env bash

set -u

host="${1:-}"
if [ -z "$host" ]; then
  echo "Usage: $0 <host>"
  echo "Example: $0 http://localhost:3000"
  echo "Example: $0 https://pizza-service.yourdomainname.click"
  exit 1
fi

# Normalize by removing a trailing slash.
host="${host%/}"

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl is required."
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required."
  exit 1
fi

pids=""

cleanup() {
  echo
  echo "Stopping traffic simulation..."
  for pid in $pids; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  wait >/dev/null 2>&1 || true
  exit 0
}

trap cleanup INT TERM

run_menu_traffic() {
  while true; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$host/api/order/menu")
    echo "Requesting menu... $code"
    sleep 3
  done
}

run_invalid_login_traffic() {
  while true; do
    code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$host/api/auth" \
      -d '{"email":"unknown@jwt.com", "password":"bad"}' \
      -H 'Content-Type: application/json')
    echo "Logging in with invalid credentials... $code"
    sleep 25
  done
}

run_franchisee_login_logout_traffic() {
  while true; do
    response=$(curl -s -X PUT "$host/api/auth" \
      -d '{"email":"f@jwt.com", "password":"franchisee"}' \
      -H 'Content-Type: application/json')
    token=$(echo "$response" | jq -r '.token // empty')

    if [ -n "$token" ]; then
      echo "Login franchisee... true"
      sleep 110
      curl -s -o /dev/null -X DELETE "$host/api/auth" -H "Authorization: Bearer $token"
    else
      echo "Login franchisee... false"
    fi

    sleep 10
  done
}

run_diner_buy_logout_traffic() {
  while true; do
    response=$(curl -s -X PUT "$host/api/auth" \
      -d '{"email":"d@jwt.com", "password":"diner"}' \
      -H 'Content-Type: application/json')
    token=$(echo "$response" | jq -r '.token // empty')

    if [ -n "$token" ]; then
      echo "Login diner... true"
      code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$host/api/order" \
        -H 'Content-Type: application/json' \
        -d '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.05 }]}' \
        -H "Authorization: Bearer $token")
      echo "Bought a pizza... $code"
      sleep 20
      curl -s -o /dev/null -X DELETE "$host/api/auth" -H "Authorization: Bearer $token"
    else
      echo "Login diner... false"
    fi

    sleep 30
  done
}

run_diner_failure_traffic() {
  while true; do
    response=$(curl -s -X PUT "$host/api/auth" \
      -d '{"email":"d@jwt.com", "password":"diner"}' \
      -H 'Content-Type: application/json')
    token=$(echo "$response" | jq -r '.token // empty')

    if [ -z "$token" ]; then
      echo "Login hungry diner... false"
      sleep 30
      continue
    fi

    echo "Login hungry diner... true"

    items='{"menuId": 1, "description": "Veggie", "price": 0.05}'
    i=0
    while [ "$i" -lt 21 ]; do
      items="$items, {\"menuId\": 1, \"description\": \"Veggie\", \"price\": 0.05}"
      i=$((i + 1))
    done

    payload="{\"franchiseId\": 1, \"storeId\":1, \"items\":[${items}]}"
    code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$host/api/order" \
      -H 'Content-Type: application/json' \
      -d "$payload" \
      -H "Authorization: Bearer $token")

    echo "Bought too many pizzas... $code"
    sleep 5
    curl -s -o /dev/null -X DELETE "$host/api/auth" -H "Authorization: Bearer $token"
    echo "Logging out hungry diner..."
    sleep 295
  done
}

echo "Starting simulated traffic against $host"

action_start() {
  "$@" &
  pids="$pids $!"
}

action_start run_menu_traffic
action_start run_invalid_login_traffic
action_start run_franchisee_login_logout_traffic
action_start run_diner_buy_logout_traffic
action_start run_diner_failure_traffic

wait
