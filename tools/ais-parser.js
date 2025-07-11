#!/usr/bin/env node

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const http = require('http');

// Your location
const MY_LAT = 51.50092998192453;
const MY_LON = -0.20671121337722095;

// Maximum reasonable distance for VHF AIS (nautical miles)
// Typical VHF range is 20-40nm, but atmospheric ducting can extend this
const MAX_REASONABLE_DISTANCE = 100; // nm

// Calculate bearing between two points
function calculateBearing(lat1, lon1, lat2, lon2) {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    let bearing = Math.atan2(y, x);
    bearing = (bearing * 180 / Math.PI + 360) % 360; // Convert to degrees and normalize to 0-360
    return bearing;
}

// Calculate distance between two points using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const km = R * c;
    // Convert to nautical miles (1 nm = 1.852 km)
    return km / 1.852;
}

function toRad(deg) {
    return deg * (Math.PI/180);
}

// Parse timestamp to get hour
function getHour(timestamp) {
    // timestamp format: "20250711134743"
    const hour = parseInt(timestamp.substring(8, 10));
    return hour;
}

// Get date from timestamp
function getDate(timestamp) {
    // timestamp format: "20250711134743"
    return timestamp.substring(0, 8);
}

// Calculate distance distribution
function calculateDistribution(distances) {
    if (distances.length === 0) return null;
    
    const sorted = distances.sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const range = max - min;
    const binSize = range / 10;
    
    // Create 10 bins
    const bins = Array(10).fill(0);
    const binRanges = [];
    
    for (let i = 0; i < 10; i++) {
        const binMin = min + (i * binSize);
        const binMax = min + ((i + 1) * binSize);
        binRanges.push({ min: binMin, max: binMax });
    }
    
    // Count distances in each bin
    distances.forEach(dist => {
        const binIndex = Math.min(Math.floor((dist - min) / binSize), 9);
        bins[binIndex]++;
    });
    
    return { bins, binRanges, min, max, count: distances.length };
}

// Calculate beam width statistics
function calculateBeamWidth(bearings, distances) {
    if (bearings.length === 0) return null;
    
    // Sort bearings and distances together
    const combined = bearings.map((b, i) => ({ bearing: b, distance: distances[i] }));
    
    // Calculate percentile ranges for all data
    const sortedBearings = [...bearings].sort((a, b) => a - b);
    const totalCount = sortedBearings.length;
    
    // Find bearing range containing specified percentiles
    function findPercentileRange(percentile) {
        const startIdx = Math.floor((1 - percentile) / 2 * totalCount);
        const endIdx = Math.ceil((1 + percentile) / 2 * totalCount) - 1;
        
        let minBearing = sortedBearings[startIdx];
        let maxBearing = sortedBearings[endIdx];
        
        // Handle wrap-around (e.g., 350° to 10°)
        if (maxBearing - minBearing > 180) {
            // Find the best continuous range
            let bestRange = maxBearing - minBearing;
            let bestMin = minBearing;
            let bestMax = maxBearing;
            
            for (let offset = 0; offset < 360; offset += 10) {
                const adjusted = sortedBearings.map(b => (b + offset) % 360).sort((a, b) => a - b);
                const adjMin = adjusted[startIdx];
                const adjMax = adjusted[endIdx];
                const range = adjMax - adjMin;
                
                if (range < bestRange) {
                    bestRange = range;
                    bestMin = (adjMin - offset + 360) % 360;
                    bestMax = (adjMax - offset + 360) % 360;
                }
            }
            
            minBearing = bestMin;
            maxBearing = bestMax;
        }
        
        const beamWidth = maxBearing > minBearing ? 
            maxBearing - minBearing : 
            (360 - minBearing) + maxBearing;
            
        const centerBearing = maxBearing > minBearing ?
            (minBearing + maxBearing) / 2 :
            ((minBearing + maxBearing + 360) / 2) % 360;
            
        return { minBearing, maxBearing, beamWidth, centerBearing, percentile };
    }
    
    // Calculate statistics for max distance items
    const sortedByDistance = combined.sort((a, b) => b.distance - a.distance);
    const top5PercentCount = Math.max(1, Math.floor(totalCount * 0.05));
    const top5Percent = sortedByDistance.slice(0, top5PercentCount);
    
    const maxDistBearings = top5Percent.map(item => item.bearing);
    const maxDistMin = Math.min(...maxDistBearings);
    const maxDistMax = Math.max(...maxDistBearings);
    
    // Calculate circular statistics
    const meanX = bearings.reduce((sum, b) => sum + Math.cos(b * Math.PI / 180), 0) / totalCount;
    const meanY = bearings.reduce((sum, b) => sum + Math.sin(b * Math.PI / 180), 0) / totalCount;
    const meanBearing = (Math.atan2(meanY, meanX) * 180 / Math.PI + 360) % 360;
    const concentration = Math.sqrt(meanX * meanX + meanY * meanY); // 0 to 1, higher = more concentrated
    
    return {
        totalCount,
        meanBearing,
        concentration,
        percentile68: findPercentileRange(0.68),  // ±1 std dev
        percentile95: findPercentileRange(0.95),  // ±2 std dev
        percentile99: findPercentileRange(0.99),  // ±3 std dev
        maxDistance: {
            count: top5PercentCount,
            minBearing: maxDistMin,
            maxBearing: maxDistMax,
            spread: maxDistMax - maxDistMin,
            bearings: maxDistBearings.sort((a, b) => a - b),
            avgDistance: top5Percent.reduce((sum, item) => sum + item.distance, 0) / top5PercentCount
        }
    };
}

// Process a JSON file
async function processFile(filePath, allDistances = [], bearingCounts = {}, allBearings = [], debugMode = false, debugDistances = [], allPositions = [], excludeMMSIs = new Set()) {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    const stats = {};
    let excludedCount = 0;

    for await (const line of rl) {
        try {
            const data = JSON.parse(line);
            
            // Check if it's an AIS message
            if (data.topic === 'ais/data' && data.payload) {
                const payload = data.payload;
                
                // Check if MMSI should be excluded
                if (excludeMMSIs.has(payload.mmsi)) {
                    excludedCount++;
                    continue;
                }
                
                // Check if we have valid lat/lon
                if (payload.lat !== undefined && payload.lon !== undefined) {
                    // Validate coordinates are within valid ranges
                    if (Math.abs(payload.lat) > 90 || Math.abs(payload.lon) > 180) {
                        if (debugMode) {
                            console.error(`Invalid coordinates: lat=${payload.lat}, lon=${payload.lon}, MMSI=${payload.mmsi}`);
                        }
                        continue; // Skip this message
                    }
                    
                    const distance = calculateDistance(MY_LAT, MY_LON, payload.lat, payload.lon);
                    
                    // Filter out unreasonable distances
                    if (distance > MAX_REASONABLE_DISTANCE) {
                        if (debugMode) {
                            debugDistances.push({
                                distance,
                                bearing: calculateBearing(MY_LAT, MY_LON, payload.lat, payload.lon),
                                mmsi: payload.mmsi,
                                lat: payload.lat,
                                lon: payload.lon,
                                timestamp: data.timestamp,
                                raw: line
                            });
                        }
                        continue; // Skip this message
                    }
                    
                    const bearing = calculateBearing(MY_LAT, MY_LON, payload.lat, payload.lon);
                    const date = getDate(data.timestamp);
                    const hour = getHour(data.timestamp);
                    
                    // Add position for map display
                    allPositions.push({ lat: payload.lat, lon: payload.lon, bearing, distance, mmsi: payload.mmsi });
                    
                    // Add to arrays for analysis
                    allDistances.push(distance);
                    allBearings.push(bearing);
                    
                    // Track bearing (15-degree sectors)
                    const bearingSector = Math.floor(bearing / 15) * 15;
                    bearingCounts[bearingSector] = (bearingCounts[bearingSector] || 0) + 1;
                    
                    // Initialize date stats if not exists
                    if (!stats[date]) {
                        stats[date] = {
                            dayCount: 0,      // 8am-8pm
                            nightCount: 0,    // 8pm-8am
                            totalCount: 0,
                            maxDistance: 0,
                            maxDistanceMMSI: null
                        };
                    }
                    
                    // Update counts
                    stats[date].totalCount++;
                    if (hour >= 8 && hour < 20) {
                        stats[date].dayCount++;
                    } else {
                        stats[date].nightCount++;
                    }
                    
                    // Update max distance
                    if (distance > stats[date].maxDistance) {
                        stats[date].maxDistance = distance;
                        stats[date].maxDistanceMMSI = payload.mmsi;
                    }
                }
            }
        } catch (e) {
            // Skip invalid JSON lines
            console.error(`Error parsing line: ${e.message}`);
        }
    }
    
    if (excludedCount > 0) {
        console.log(`Excluded ${excludedCount} messages from specified MMSIs`);
    }

    return stats;
}

// Process directory of files
async function processDirectory(dirPath, allDistances = [], bearingCounts = {}, allBearings = [], debugMode = false, debugDistances = [], allPositions = [], excludeMMSIs = new Set()) {
    const files = fs.readdirSync(dirPath);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    
    let allStats = {};
    
    for (const file of jsonFiles) {
        console.log(`Processing ${file}...`);
        const filePath = path.join(dirPath, file);
        const fileStats = await processFile(filePath, allDistances, bearingCounts, allBearings, debugMode, debugDistances, allPositions, excludeMMSIs);
        
        // Merge stats
        for (const date in fileStats) {
            if (!allStats[date]) {
                allStats[date] = fileStats[date];
            } else {
                // Combine stats if date already exists
                allStats[date].dayCount += fileStats[date].dayCount;
                allStats[date].nightCount += fileStats[date].nightCount;
                allStats[date].totalCount += fileStats[date].totalCount;
                
                // Update max distance if needed
                if (fileStats[date].maxDistance > allStats[date].maxDistance) {
                    allStats[date].maxDistance = fileStats[date].maxDistance;
                    allStats[date].maxDistanceMMSI = fileStats[date].maxDistanceMMSI;
                }
            }
        }
    }
    
    return { stats: allStats, distances: allDistances, bearings: bearingCounts, allBearings: allBearings, positions: allPositions };
}

// Create simple web server for map display
function startMapServer(port, mapData) {
    const server = http.createServer((req, res) => {
        if (req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<!DOCTYPE html>
<html>
<head>
<script>
const centerLat = ${MY_LAT};
const centerLon = ${MY_LON};
const positions = ${JSON.stringify(mapData.positions)};
const beamStats = ${JSON.stringify(mapData.beamStats)};
const minDistance = ${mapData.minDistance || 0};

let map;

function initMap() {
    map = new google.maps.Map(document.getElementById('map'), {
        center: { lat: centerLat, lng: centerLon },
        zoom: 10,
        mapTypeControl: true,
        mapTypeControlOptions: {
            mapTypeIds: ['roadmap', 'satellite']
        },
        mapId: 'ais_map' // Required for AdvancedMarkerElement
    });
    
    // Center marker using AdvancedMarkerElement
    new google.maps.marker.AdvancedMarkerElement({
        position: { lat: centerLat, lng: centerLon },
        map: map,
        title: 'Station',
        content: buildContent('Station', '#FF0000')
    });
    
    // Draw minimum distance circle if specified
    if (minDistance > 0) {
        new google.maps.Circle({
            map: map,
            center: { lat: centerLat, lng: centerLon },
            radius: minDistance * 1852, // Convert nm to meters
            fillColor: '#FF0000',
            fillOpacity: 0.05,
            strokeColor: '#FF0000',
            strokeOpacity: 0.3,
            strokeWeight: 1
        });
        
        // Add label using AdvancedMarkerElement
        const labelLatLng = computeOffset(centerLat, centerLon, minDistance * 1852, 90);
        new google.maps.marker.AdvancedMarkerElement({
            position: labelLatLng,
            map: map,
            content: buildTextLabel(minDistance + ' nm')
        });
    }
    
    // Plot all positions as small dots
    positions.forEach(pos => {
        new google.maps.Circle({
            map: map,
            center: { lat: pos.lat, lng: pos.lon },
            radius: 50,
            fillColor: '#0000FF',
            fillOpacity: 0.3,
            strokeWeight: 0
        });
    });
    
    // Draw beam width lines
    if (beamStats) {
        // Calculate max distance for beam lines
        const maxDist = Math.max(...positions.map(p => p.distance)) * 1.1 * 1852; // nm to meters + 10%
        
        // 68% beam
        drawBeamLine(map, centerLat, centerLon, beamStats.percentile68.minBearing, maxDist, '#00FF00', '68%');
        drawBeamLine(map, centerLat, centerLon, beamStats.percentile68.maxBearing, maxDist, '#00FF00', '68%');
        
        // 95% beam
        drawBeamLine(map, centerLat, centerLon, beamStats.percentile95.minBearing, maxDist, '#FFFF00', '95%');
        drawBeamLine(map, centerLat, centerLon, beamStats.percentile95.maxBearing, maxDist, '#FFFF00', '95%');
    }
    
    // Display filter info
    if (minDistance > 0) {
        const info = document.createElement('div');
        info.style.position = 'absolute';
        info.style.top = '10px';
        info.style.left = '10px';
        info.style.background = 'white';
        info.style.padding = '5px';
        info.style.fontSize = '12px';
        info.textContent = 'Min distance: ' + minDistance + ' nm';
        document.body.appendChild(info);
    }
}

function buildContent(label, color) {
    const content = document.createElement('div');
    content.style.width = '10px';
    content.style.height = '10px';
    content.style.backgroundColor = color;
    content.style.border = '2px solid white';
    content.style.borderRadius = '50%';
    return content;
}

function buildTextLabel(text) {
    const content = document.createElement('div');
    content.style.backgroundColor = 'white';
    content.style.padding = '2px 4px';
    content.style.fontSize = '11px';
    content.style.border = '1px solid #ccc';
    content.textContent = text;
    return content;
}

function computeOffset(lat, lon, distance, bearing) {
    const R = 6371000; // Earth radius in meters
    const brng = bearing * Math.PI / 180;
    const lat1 = lat * Math.PI / 180;
    const lon1 = lon * Math.PI / 180;
    
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance / R) +
                Math.cos(lat1) * Math.sin(distance / R) * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(distance / R) * Math.cos(lat1),
                Math.cos(distance / R) - Math.sin(lat1) * Math.sin(lat2));
    
    return { lat: lat2 * 180 / Math.PI, lng: lon2 * 180 / Math.PI };
}

function drawBeamLine(map, lat, lon, bearing, distance, color, label) {
    const endPoint = computeOffset(lat, lon, distance, bearing);
    
    const line = new google.maps.Polyline({
        path: [
            { lat: lat, lng: lon },
            endPoint
        ],
        geodesic: true,
        strokeColor: color,
        strokeOpacity: 0.8,
        strokeWeight: 2,
        map: map
    });
}

// Load the map asynchronously
window.onload = function() {
    const script = document.createElement('script');
    script.src = 'https://maps.googleapis.com/maps/api/js?key=${mapData.apiKey}&libraries=geometry,marker&callback=initMap&loading=async';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
};
</script>
<style>
html, body { height: 100%; margin: 0; padding: 0; }
#map { height: 100%; }
</style>
</head>
<body>
<div id="map"></div>
</body>
</html>`);
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    });
    
    server.listen(port, () => {
        console.log(`\nMap server running at http://localhost:${port}/`);
        console.log('Open this URL in your browser to view the AIS data on Google Maps');
    });
}

// Get compass direction from bearing
function getCompassDirection(bearing) {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 
                       'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(bearing / 22.5) % 16;
    return directions[index];
}

// Main function
async function main() {
    const args = process.argv.slice(2);
    
    // Check for debug flag
    const debugMode = args.includes('--debug');
    
    // Check for display flag
    let displayPort = null;
    const displayArg = args.find(arg => arg.startsWith('--display'));
    if (displayArg) {
        if (displayArg === '--display') {
            displayPort = 9001;
        } else if (displayArg.includes('=')) {
            displayPort = parseInt(displayArg.split('=')[1]);
        }
    }
    
    // Check for API key
    let apiKey = null;
    const apiKeyArg = args.find(arg => arg.startsWith('--apikey='));
    if (apiKeyArg) {
        apiKey = apiKeyArg.split('=')[1];
    }
    
    // Check for min-distance flag
    let minDistance = 0;
    const minDistArg = args.find(arg => arg.startsWith('--min-distance='));
    if (minDistArg) {
        minDistance = parseFloat(minDistArg.split('=')[1]);
    }
    
    // Check for exclude flag
    let excludeMMSIs = new Set();
    const excludeArg = args.find(arg => arg.startsWith('--exclude='));
    if (excludeArg) {
        const mmsiList = excludeArg.split('=')[1].split(',').map(m => parseInt(m));
        excludeMMSIs = new Set(mmsiList);
        console.log(`Excluding MMSIs: ${Array.from(excludeMMSIs).join(', ')}`);
    }
    
    const filteredArgs = args.filter(arg => 
        arg !== '--debug' && 
        !arg.startsWith('--display') && 
        !arg.startsWith('--min-distance') &&
        !arg.startsWith('--exclude') &&
        !arg.startsWith('--apikey')
    );
    
    if (filteredArgs.length === 0) {
        console.log('Usage: node ais-parser.js <file.json or directory> [options]');
        console.log('Options:');
        console.log('  --debug                    Show debug information');
        console.log('  --display[=port]           Start map server (default port: 9001)');
        console.log('  --apikey=KEY               Google Maps API key (required for --display)');
        console.log('  --min-distance=nm          Only analyze signals beyond this distance');
        console.log('  --exclude=mmsi1,mmsi2,...  Exclude specific MMSIs');
        console.log('\nExamples:');
        console.log('  ./ais-parser.js data.json --display --apikey=YOUR_KEY');
        console.log('  ./ais-parser.js data.json --display --apikey=YOUR_KEY --min-distance=5');
        console.log('  ./ais-parser.js data.json --exclude=2320752,235054667');
        process.exit(1);
    }
    
    // Validate API key if display is requested
    if (displayPort && !apiKey) {
        console.error('Error: --apikey is required when using --display');
        console.error('Usage: ./ais-parser.js data.json --display --apikey=YOUR_GOOGLE_MAPS_KEY');
        process.exit(1);
    }
    
    const inputPath = filteredArgs[0];
    let stats = {};
    let allDistances = [];
    let bearingCounts = {};
    let allBearings = [];
    let debugDistances = [];
    let allPositions = [];
    
    // Check if input is file or directory
    if (fs.statSync(inputPath).isDirectory()) {
        const result = await processDirectory(inputPath, allDistances, bearingCounts, allBearings, debugMode, debugDistances, allPositions, excludeMMSIs);
        stats = result.stats;
        allDistances = result.distances;
        bearingCounts = result.bearings;
        allBearings = result.allBearings;
        allPositions = result.positions;
    } else {
        stats = await processFile(inputPath, allDistances, bearingCounts, allBearings, debugMode, debugDistances, allPositions, excludeMMSIs);
    }
    
    // Apply minimum distance filter if specified
    let filteredDistances = allDistances;
    let filteredBearings = allBearings;
    let filteredPositions = allPositions;
    
    if (minDistance > 0) {
        console.log(`\nApplying minimum distance filter: ${minDistance} nm`);
        
        // Filter arrays based on distance
        const indices = allDistances.map((d, i) => d >= minDistance ? i : -1).filter(i => i >= 0);
        filteredDistances = indices.map(i => allDistances[i]);
        filteredBearings = indices.map(i => allBearings[i]);
        filteredPositions = indices.map(i => allPositions[i]);
        
        console.log(`Filtered from ${allDistances.length} to ${filteredDistances.length} positions`);
    }
    
    // Debug output for suspicious distances
    if (debugMode && debugDistances.length > 0) {
        console.log('\n=== DEBUG: Filtered Messages ===');
        console.log(`Filtered ${debugDistances.length} messages with distance > ${MAX_REASONABLE_DISTANCE} nm\n`);
        
        // Sort by distance descending
        debugDistances.sort((a, b) => b.distance - a.distance);
        
        // Show top 10 most extreme
        const showCount = Math.min(10, debugDistances.length);
        for (let i = 0; i < showCount; i++) {
            const d = debugDistances[i];
            console.log(`\n--- Message ${i + 1} ---`);
            console.log(`Distance: ${d.distance.toFixed(2)} nm`);
            console.log(`Bearing: ${d.bearing.toFixed(1)}°`);
            console.log(`MMSI: ${d.mmsi}`);
            console.log(`Position: ${d.lat}, ${d.lon}`);
            console.log(`Timestamp: ${d.timestamp}`);
            console.log(`Raw message: ${d.raw.substring(0, 200)}...`);
        }
        console.log('\n=== END DEBUG ===\n');
    }
    
    // Print results
    console.log('\nAIS Message Statistics:');
    console.log('=======================');
    console.log(`Your location: ${MY_LAT}, ${MY_LON}\n`);
    
    // Sort dates
    const sortedDates = Object.keys(stats).sort();
    
    console.log('Date       | Day (8am-8pm) | Night (8pm-8am) | Total | Max Distance (nm) | MMSI');
    console.log('-----------|---------------|-----------------|-------|-------------------|----------');
    
    for (const date of sortedDates) {
        const s = stats[date];
        const dateFormatted = `${date.substring(0,4)}-${date.substring(4,6)}-${date.substring(6,8)}`;
        console.log(
            `${dateFormatted} | ${s.dayCount.toString().padStart(13)} | ${s.nightCount.toString().padStart(15)} | ${s.totalCount.toString().padStart(5)} | ${s.maxDistance.toFixed(2).padStart(17)} | ${s.maxDistanceMMSI || 'N/A'}`
        );
    }
    
    // Summary
    const totalMessages = sortedDates.reduce((sum, date) => sum + stats[date].totalCount, 0);
    const totalDay = sortedDates.reduce((sum, date) => sum + stats[date].dayCount, 0);
    const totalNight = sortedDates.reduce((sum, date) => sum + stats[date].nightCount, 0);
    let overallMaxDistance = 0;
    let overallMaxMMSI = null;
    
    for (const date of sortedDates) {
        if (stats[date].maxDistance > overallMaxDistance) {
            overallMaxDistance = stats[date].maxDistance;
            overallMaxMMSI = stats[date].maxDistanceMMSI;
        }
    }
    
    console.log('\nSummary:');
    console.log(`Total messages: ${totalMessages}`);
    console.log(`Day messages (8am-8pm): ${totalDay}`);
    console.log(`Night messages (8pm-8am): ${totalNight}`);
    console.log(`Overall max distance: ${overallMaxDistance.toFixed(2)} nm (MMSI: ${overallMaxMMSI})`);
    
    // Distance distribution - use filtered data
    const distribution = calculateDistribution(filteredDistances);
    if (distribution) {
        console.log('\nDistance Distribution (in 10ths):');
        console.log('=================================');
        console.log(`Min distance: ${distribution.min.toFixed(2)} nm`);
        console.log(`Max distance: ${distribution.max.toFixed(2)} nm`);
        console.log(`Total AIS messages with valid positions: ${distribution.count}\n`);
        
        console.log('Range (nm)                  | Count  | Percentage');
        console.log('----------------------------|--------|------------');
        
        distribution.bins.forEach((count, i) => {
            const range = distribution.binRanges[i];
            const percentage = ((count / distribution.count) * 100).toFixed(1);
            const rangeStr = `${range.min.toFixed(2)} - ${range.max.toFixed(2)}`;
            console.log(
                `${rangeStr.padEnd(27)} | ${count.toString().padStart(6)} | ${percentage.padStart(10)}%`
            );
        });
    }
    
    // Bearing distribution - recalculate with filtered data
    if (minDistance > 0 && filteredBearings.length > 0) {
        // Recalculate bearing counts for filtered data
        const filteredBearingCounts = {};
        filteredBearings.forEach(bearing => {
            const bearingSector = Math.floor(bearing / 15) * 15;
            filteredBearingCounts[bearingSector] = (filteredBearingCounts[bearingSector] || 0) + 1;
        });
        bearingCounts = filteredBearingCounts;
    }
    
    // Bearing distribution
    console.log('\nBearing Distribution (15° sectors):');
    console.log('===================================');
    
    // Get sorted bearings and filter out zero counts
    const bearings = Object.keys(bearingCounts)
        .map(b => parseInt(b))
        .sort((a, b) => a - b)
        .filter(b => bearingCounts[b] > 0);
    
    if (bearings.length > 0) {
        const totalBearingCount = bearings.reduce((sum, b) => sum + bearingCounts[b], 0);
        
        console.log('Bearing Range | Direction | Count  | Percentage');
        console.log('--------------|-----------|--------|------------');
        
        bearings.forEach(bearing => {
            const count = bearingCounts[bearing];
            const percentage = ((count / totalBearingCount) * 100).toFixed(1);
            const endBearing = bearing + 15;
            const midBearing = bearing + 7.5;
            const direction = getCompassDirection(midBearing);
            const rangeStr = `${bearing.toString().padStart(3)}° - ${endBearing.toString().padStart(3)}°`;
            
            console.log(
                `${rangeStr} | ${direction.padEnd(9)} | ${count.toString().padStart(6)} | ${percentage.padStart(10)}%`
            );
        });
        
        console.log(`\nTotal messages: ${totalBearingCount}`);
    }
    
    // Beam width analysis - use filtered data
    const beamStats = calculateBeamWidth(filteredBearings, filteredDistances);
    if (beamStats) {
        console.log('\nBeam Width Analysis:');
        console.log('====================');
        if (minDistance > 0) {
            console.log(`*** Analyzing only signals > ${minDistance} nm ***`);
        }
        console.log(`Mean bearing: ${beamStats.meanBearing.toFixed(1)}° (${getCompassDirection(beamStats.meanBearing)})`);
        console.log(`Concentration factor: ${beamStats.concentration.toFixed(3)} (0=omnidirectional, 1=unidirectional)`);
        
        console.log('\nStatistical Beam Width:');
        console.log(`68% of signals (±1σ): ${beamStats.percentile68.beamWidth.toFixed(1)}° beam width`);
        console.log(`  Range: ${beamStats.percentile68.minBearing.toFixed(1)}° - ${beamStats.percentile68.maxBearing.toFixed(1)}°`);
        console.log(`  Center: ${beamStats.percentile68.centerBearing.toFixed(1)}°`);
        
        console.log(`\n95% of signals (±2σ): ${beamStats.percentile95.beamWidth.toFixed(1)}° beam width`);
        console.log(`  Range: ${beamStats.percentile95.minBearing.toFixed(1)}° - ${beamStats.percentile95.maxBearing.toFixed(1)}°`);
        console.log(`  Center: ${beamStats.percentile95.centerBearing.toFixed(1)}°`);
        
        console.log(`\n99% of signals (±3σ): ${beamStats.percentile99.beamWidth.toFixed(1)}° beam width`);
        console.log(`  Range: ${beamStats.percentile99.minBearing.toFixed(1)}° - ${beamStats.percentile99.maxBearing.toFixed(1)}°`);
        console.log(`  Center: ${beamStats.percentile99.centerBearing.toFixed(1)}°`);
        
        console.log('\nMax Distance Analysis:');
        console.log(`Top 5% furthest signals (${beamStats.maxDistance.count} messages):`);
        console.log(`  Average distance: ${beamStats.maxDistance.avgDistance.toFixed(2)} nm`);
        console.log(`  Bearing spread: ${beamStats.maxDistance.spread.toFixed(1)}°`);
        console.log(`  Bearing range: ${beamStats.maxDistance.minBearing.toFixed(1)}° - ${beamStats.maxDistance.maxBearing.toFixed(1)}°`);
        
        if (beamStats.maxDistance.bearings.length <= 20) {
            console.log(`  Individual bearings: ${beamStats.maxDistance.bearings.map(b => b.toFixed(1) + '°').join(', ')}`);
        }
    }
    
    // Start map server if requested
    if (displayPort) {
        startMapServer(displayPort, {
            positions: filteredPositions,
            beamStats: beamStats,
            minDistance: minDistance,
            apiKey: apiKey
        });
    }
}

// Run the script
main().catch(console.error);
