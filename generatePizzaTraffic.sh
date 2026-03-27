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

is_positive_int() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

traffic_multiplier="${TRAFFIC_MULTIPLIER:-4}"
if ! is_positive_int "$traffic_multiplier"; then
  echo "Error: TRAFFIC_MULTIPLIER must be a positive integer."
  exit 1
fi

menu_workers="${MENU_WORKERS:-$((traffic_multiplier * 2))}"
invalid_login_workers="${INVALID_LOGIN_WORKERS:-$traffic_multiplier}"
franchisee_workers="${FRANCHISEE_WORKERS:-$traffic_multiplier}"
diner_buy_workers="${DINER_BUY_WORKERS:-$((traffic_multiplier * 4))}"
diner_failure_workers="${DINER_FAILURE_WORKERS:-$traffic_multiplier}"

for count in "$menu_workers" "$invalid_login_workers" "$franchisee_workers" "$diner_buy_workers" "$diner_failure_workers"; do
  if ! is_positive_int "$count"; then
    echo "Error: worker counts must be positive integers."
    exit 1
  fi
done

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
  worker_id="$1"
  while true; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$host/api/order/menu")
    echo "[menu-$worker_id] Requesting menu... $code"
    sleep 1
  done
}

run_invalid_login_traffic() {
  worker_id="$1"
  while true; do
    code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$host/api/auth" \
      -d '{"email":"unknown@jwt.com", "password":"bad"}' \
      -H 'Content-Type: application/json')
    echo "[bad-login-$worker_id] Logging in with invalid credentials... $code"
    sleep 2
  done
}

run_franchisee_login_logout_traffic() {
  worker_id="$1"
  while true; do
    response=$(curl -s -X PUT "$host/api/auth" \
      -d '{"email":"f@jwt.com", "password":"franchisee"}' \
      -H 'Content-Type: application/json')
    token=$(echo "$response" | jq -r '.token // empty')

    if [ -n "$token" ]; then
      echo "[franchisee-$worker_id] Login franchisee... true"
      sleep 20
      curl -s -o /dev/null -X DELETE "$host/api/auth" -H "Authorization: Bearer $token"
    else
      echo "[franchisee-$worker_id] Login franchisee... false"
    fi

    sleep 5
  done
}

run_diner_buy_logout_traffic() {
  worker_id="$1"
  while true; do
    response=$(curl -s -X PUT "$host/api/auth" \
      -d '{"email":"d@jwt.com", "password":"diner"}' \
      -H 'Content-Type: application/json')
    token=$(echo "$response" | jq -r '.token // empty')

    if [ -n "$token" ]; then
      echo "[buyer-$worker_id] Login diner... true"
      code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$host/api/order" \
        -H 'Content-Type: application/json' \
        -d '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.05 }, { "menuId": 1, "description": "Veggie", "price": 0.05 }, { "menuId": 1, "description": "Veggie", "price": 0.05 }, { "menuId": 1, "description": "Veggie", "price": 0.05 }]}' \
        -H "Authorization: Bearer $token")
      echo "[buyer-$worker_id] Bought pizzas... $code"
      sleep 1
      curl -s -o /dev/null -X DELETE "$host/api/auth" -H "Authorization: Bearer $token"
    else
      echo "[buyer-$worker_id] Login diner... false"
    fi

    sleep 2
  done
}

run_diner_failure_traffic() {
  worker_id="$1"
  while true; do
    response=$(curl -s -X PUT "$host/api/auth" \
      -d '{"email":"d@jwt.com", "password":"diner"}' \
      -H 'Content-Type: application/json')
    token=$(echo "$response" | jq -r '.token // empty')

    if [ -z "$token" ]; then
      echo "[hungry-$worker_id] Login hungry diner... false"
      sleep 5
      continue
    fi

    echo "[hungry-$worker_id] Login hungry diner... true"

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

    echo "[hungry-$worker_id] Bought too many pizzas... $code"
    sleep 1
    curl -s -o /dev/null -X DELETE "$host/api/auth" -H "Authorization: Bearer $token"
    echo "[hungry-$worker_id] Logging out hungry diner..."
    sleep 20
  done
}

echo "Starting simulated traffic against $host"
echo "TRAFFIC_MULTIPLIER=$traffic_multiplier"
echo "MENU_WORKERS=$menu_workers INVALID_LOGIN_WORKERS=$invalid_login_workers FRANCHISEE_WORKERS=$franchisee_workers DINER_BUY_WORKERS=$diner_buy_workers DINER_FAILURE_WORKERS=$diner_failure_workers"

action_start() {
  "$@" &
  pids="$pids $!"
}

start_workers() {
  action="$1"
  count="$2"
  i=1
  while [ "$i" -le "$count" ]; do
    action_start "$action" "$i"
    i=$((i + 1))
  done
}

start_workers run_menu_traffic "$menu_workers"
start_workers run_invalid_login_traffic "$invalid_login_workers"
start_workers run_franchisee_login_logout_traffic "$franchisee_workers"
start_workers run_diner_buy_logout_traffic "$diner_buy_workers"
start_workers run_diner_failure_traffic "$diner_failure_workers"

wait
