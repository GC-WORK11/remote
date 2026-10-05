#!/bin/bash
# fake-omp — protocol-shaped stand-in for `omp --mode rpc` used for load tests.
# Speaks just enough ndjson-RPC to satisfy omprd: answers the handshake, then
# on any `prompt` frame emits FAKE_N (default 200) message_delta frames and a
# prompt_result. Everything else gets a generic success response that echoes
# the request's "id" — required so omprd-correlated requests (daemon-issued
# get_state/compact) route privately instead of leaking into the broadcast.
# FAKE_N env sets the burst size; FAKE_SLEEP_MS adds a delay between frames.
N=${FAKE_N:-200}
SLEEP=${FAKE_SLEEP_MS:-0}
while IFS= read -r line; do
	# pull "id":"..." out of the request line (requests carry one when the
	# daemon or client wants a routed response)
	rid=$(printf '%s' "$line" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
	case "$line" in
	*negotiate_protocol*)
		echo '{"id":"omprd-handshake","type":"response","command":"negotiate_protocol","success":true,"data":{"protocolVersion":2}}'
		;;
	*'"prompt"'*)
		# per-prompt scenarios via a SCENARIO:<name> marker in the prompt text,
		# so one daemon exercises every busy-flag transition:
		#   busy     → agent_start … prompt_result (busy window in between)
		#   retry    → agent_start, auto_retry_start, auto_retry_end{success},
		#              then the rest of the turn — busy must survive success
		#   agentend → agent_start … agent_end, no prompt_result
		if printf '%s' "$line" | grep -q 'SCENARIO:busy'; then
			echo '{"type":"agent_start"}'
			sleep 0.6
			printf '{"type":"message_delta","seq":1,"delta":"busy-tok"}\n'
			sleep 0.3
			if [ -n "$rid" ]; then
				printf '{"id":"%s","type":"prompt_result","status":"ok","sessionSettled":true,"usage":{"input_tokens":123,"output_tokens":45}}\n' "$rid"
			else
				echo '{"type":"prompt_result","status":"ok","sessionSettled":true,"usage":{"input_tokens":123,"output_tokens":45}}'
			fi
		elif printf '%s' "$line" | grep -q 'SCENARIO:retry'; then
			echo '{"type":"agent_start"}'
			echo '{"type":"auto_retry_start","attempt":1,"errorMessage":"rate limit"}'
			echo '{"type":"auto_retry_end","success":true}'
			sleep 0.8
			printf '{"type":"message_delta","seq":1,"delta":"resumed-after-retry"}\n'
			if [ -n "$rid" ]; then
				printf '{"id":"%s","type":"prompt_result","status":"ok","sessionSettled":true,"usage":{"input_tokens":123,"output_tokens":45}}\n' "$rid"
			else
				echo '{"type":"prompt_result","status":"ok","sessionSettled":true,"usage":{"input_tokens":123,"output_tokens":45}}'
			fi
		elif printf '%s' "$line" | grep -q 'SCENARIO:agentend'; then
			echo '{"type":"agent_start"}'
			printf '{"type":"message_delta","seq":1,"delta":"pre-end"}\n'
			sleep 0.4
			echo '{"type":"agent_end"}'
		else
			i=1
			while [ $i -le "$N" ]; do
				printf '{"type":"message_delta","seq":%d,"delta":"tok-%d lorem ipsum dolor sit amet consectetur"}\n' "$i" "$i"
				i=$((i + 1))
				if [ "$SLEEP" -gt 0 ]; then
					python3 -c "import time;time.sleep($SLEEP/1000.0)" 2>/dev/null || true
				fi
			done
			if [ -n "$rid" ]; then
				printf '{"id":"%s","type":"prompt_result","status":"ok","sessionSettled":true,"usage":{"input_tokens":123,"output_tokens":45}}\n' "$rid"
			else
				echo '{"type":"prompt_result","status":"ok","sessionSettled":true,"usage":{"input_tokens":123,"output_tokens":45}}'
			fi
		fi
		;;
	*get_state*)
		if [ -n "$rid" ]; then
			printf '{"id":"%s","type":"response","command":"get_state","success":true,"data":{"contextUsage":{"tokens":1234,"contextWindow":128000,"percent":1.0}}}\n' "$rid"
		else
			echo '{"type":"response","command":"get_state","success":true,"data":{"contextUsage":{"tokens":1234,"contextWindow":128000,"percent":1.0}}}'
		fi
		;;
	*)
		if [ -n "$rid" ]; then
			printf '{"id":"%s","type":"response","success":true,"data":{}}\n' "$rid"
		else
			echo '{"type":"response","success":true,"data":{}}'
		fi
		;;
	esac
done
