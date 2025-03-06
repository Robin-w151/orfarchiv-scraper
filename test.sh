#!/bin/bash -e

count=$(node --experimental-strip-types ./tests/count.ts)

if [ "$count" != "0" ]; then
  echo "DB should be empty before a test is run!"
  exit 1
fi

sh ./run.sh

count=$(node --experimental-strip-types ./tests/count.ts)

if [ "$count" = "0" ]; then
  echo "No documents in the DB after scraper is run!"
  exit 1
fi
