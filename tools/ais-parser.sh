#!/bin/bash

# Default values (non-full mode)
DISPLAY_ARG="--display=9100"
MIN_DISTANCE_ARG="--min-distance=3"

# Check if --full flag is provided
if [ "$1" = "--full" ]; then
    DISPLAY_ARG=""
    MIN_DISTANCE_ARG=""
fi

# Run the command with appropriate arguments
./ais-parser.js /opt/storage/collector/messages \
    ${DISPLAY_ARG} \
    ${MIN_DISTANCE_ARG} \
    --exclude=`cat ais-parser.exclude` \
    --apikey=`cat .apikey`
