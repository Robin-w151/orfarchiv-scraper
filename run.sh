#!/bin/bash -e

scriptDir=$(dirname "$0")
dbUrlFile="$1"

if [ -n "$dbUrlFile" ]; then
  ORFARCHIV_DB_URL_FILE="$dbUrlFile"
  export ORFARCHIV_DB_URL_FILE
fi

export NODE_NO_WARNINGS=1

cd "$scriptDir"
timeout 60s npm start
