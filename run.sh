#!/bin/bash -e

scriptDir=$(dirname "$0")
export NODE_NO_WARNINGS=1

cd "$scriptDir"
npm start -- "$@"
