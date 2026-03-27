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

curl_connect_timeout="${CURL_CONNECT_TIMEOUT:-5}"
curl_max_time="${CURL_MAX_TIME:-15}"
token_ttl_seconds="${TOKEN_TTL_SECONDS:-240}"

is_positive_int() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

traffic_multiplier="${TRAFFIC_MULTIPLIER:-4}"
if ! is_positive_int "$traffic_multiplier"; then
  echo "Error: TRAFFIC_MULTIPLIER must be a positive integer."
  exit 1
fi

for value in "$curl_connect_timeout" "$curl_max_time" "$token_ttl_seconds"; do
  if ! is_positive_int "$value"; then
    echo "Error: CURL_CONNECT_TIMEOUT, CURL_MAX_TIME, and TOKEN_TTL_SECONDS must be positive integers."
    exit 1
  fi
done

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

REQUEST_CODE=""
REQUEST_BODY=""

request_json() {
  method="$1"
  url="$2"
  data="${3:-}"
  token="${4:-}"

  args=(
    -sS
    --connect-timeout "$curl_connect_timeout"
    --max-time "$curl_max_time"
    -w "\n%{http_code}"
    -X "$method"
    "$url"
    -H 'Content-Type: application/json'
  )

  if [ -n "$data" ]; then
    args+=( -d "$data" )
  fi

  if [ -n "$token" ]; then
    args+=( -H "Authorization: Bearer $token" )
  fi

  response=$(curl "${args[@]}")
  curl_status=$?

  if [ "$curl_status" -ne 0 ]; then
    REQUEST_CODE="000"
    REQUEST_BODY=""
    return 1
  fi

  REQUEST_CODE="${response##*$'\n'}"
  REQUEST_BODY="${response%$'\n'*}"
  return 0
}

login_token() {
  email="$1"
  password="$2"

  if ! request_json "PUT" "$host/api/auth" "{\"email\":\"$email\",\"password\":\"$password\"}"; then
    return 1
  fi

  if [ "$REQUEST_CODE" != "200" ]; then
    return 1
  fi

  token=$(printf '%s' "$REQUEST_BODY" | jq -r '.token // empty' 2>/dev/null || true)
  if [ -z "$token" ]; then
    return 1
  fi

  printf '%s' "$token"
  return 0
}

token_age_seconds() {
  issued_at="$1"
  now=$(date +%s)
  echo $((now - issued_at))
}

ensure_fresh_token() {
  current_token="$1"
  issued_at="$2"
  email="$3"
  password="$4"

  if [ -n "$current_token" ] && [ "$(token_age_seconds "$issued_at")" -lt "$token_ttl_seconds" ]; then
    printf '%s\n%s' "$current_token" "$issued_at"
    return 0
  fi

  new_token=$(login_token "$email" "$password") || return 1
  now=$(date +%s)
  printf '%s\n%s' "$new_token" "$now"
  return 0
}

logout_token() {
  token="$1"
  if [ -z "$token" ]; then
    return 0
  fi

  request_json "DELETE" "$host/api/auth" "" "$token" >/dev/null 2>&1 || true
  return 0
}

run_menu_traffic() {
  worker_id="$1"
  while true; do
    code=$(curl -sS --connect-timeout "$curl_connect_timeout" --max-time "$curl_max_time" -o /dev/null -w "%{http_code}" "$host/api/order/menu" || echo "000")
    echo "[menu-$worker_id] Requesting menu... $code"
    sleep 1
  done
}

run_invalid_login_traffic() {
  worker_id="$1"
  while true; do
    code=$(curl -sS --connect-timeout "$curl_connect_timeout" --max-time "$curl_max_time" -o /dev/null -w "%{http_code}" -X PUT "$host/api/auth" \
      -d '{"email":"unknown@jwt.com", "password":"bad"}' \
      -H 'Content-Type: application/json' || echo "000")
    echo "[bad-login-$worker_id] Logging in with invalid credentials... $code"
    sleep 2
  done
}

run_franchisee_login_logout_traffic() {
  worker_id="$1"
  token=""
  issued_at=0
  while true; do
    token_and_time=$(ensure_fresh_token "$token" "$issued_at" "f@jwt.com" "franchisee")
    if [ -n "$token_and_time" ]; then
      token=$(echo "$token_and_time" | sed -n '1p')
      issued_at=$(echo "$token_and_time" | sed -n '2p')
      echo "[franchisee-$worker_id] Login franchisee... true"
      sleep 20
      logout_token "$token"
      token=""
      issued_at=0
    else
      echo "[franchisee-$worker_id] Login franchisee... false"
    fi

    sleep 5
  done
}

run_diner_buy_logout_traffic() {
  worker_id="$1"
  token=""
  issued_at=0
  while true; do
    token_and_time=$(ensure_fresh_token "$token" "$issued_at" "d@jwt.com" "diner")
    if [ -n "$token_and_time" ]; then
      token=$(echo "$token_and_time" | sed -n '1p')
      issued_at=$(echo "$token_and_time" | sed -n '2p')
      echo "[buyer-$worker_id] Login diner... true"
      request_json "POST" "$host/api/order" '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.05 }, { "menuId": 1, "description": "Veggie", "price": 0.05 }, { "menuId": 1, "description": "Veggie", "price": 0.05 }, { "menuId": 1, "description": "Veggie", "price": 0.05 }]}' "$token" || true
      code="$REQUEST_CODE"

      if [ "$code" = "401" ] || [ "$code" = "403" ]; then
        token=$(login_token "d@jwt.com" "diner") || token=""
        issued_at=$(date +%s)
        if [ -n "$token" ]; then
          request_json "POST" "$host/api/order" '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.05 }, { "menuId": 1, "description": "Veggie", "price": 0.05 }, { "menuId": 1, "description": "Veggie", "price": 0.05 }, { "menuId": 1, "description": "Veggie", "price": 0.05 }]}' "$token" || true
          code="$REQUEST_CODE"
        fi
      fi

      echo "[buyer-$worker_id] Bought pizzas... $code"
      sleep 1
      logout_token "$token"
      token=""
      issued_at=0
    else
      echo "[buyer-$worker_id] Login diner... false"
    fi

    sleep 2
  done
}

run_diner_failure_traffic() {
  worker_id="$1"
  token=""
  issued_at=0
  while true; do
    token_and_time=$(ensure_fresh_token "$token" "$issued_at" "d@jwt.com" "diner")
    if [ -n "$token_and_time" ]; then
      token=$(echo "$token_and_time" | sed -n '1p')
      issued_at=$(echo "$token_and_time" | sed -n '2p')
    else
      token=""
    fi

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
    request_json "POST" "$host/api/order" "$payload" "$token" || true
    code="$REQUEST_CODE"

    if [ "$code" = "401" ] || [ "$code" = "403" ]; then
      token=$(login_token "d@jwt.com" "diner") || token=""
      issued_at=$(date +%s)
      if [ -n "$token" ]; then
        request_json "POST" "$host/api/order" "$payload" "$token" || true
        code="$REQUEST_CODE"
      fi
    fi

    echo "[hungry-$worker_id] Bought too many pizzas... $code"
    sleep 1
    logout_token "$token"
    token=""
    issued_at=0
    echo "[hungry-$worker_id] Logging out hungry diner..."
    sleep 20
  done
}

echo "Starting simulated traffic against $host"
echo "TRAFFIC_MULTIPLIER=$traffic_multiplier"
echo "CURL_CONNECT_TIMEOUT=$curl_connect_timeout CURL_MAX_TIME=$curl_max_time TOKEN_TTL_SECONDS=$token_ttl_seconds"
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
