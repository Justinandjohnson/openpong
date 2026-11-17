"use client";

import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { divIcon, latLngBounds } from "leaflet";
import { useEffect, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import type { Tournament } from "@/lib/api";

/**
 * City coordinates are presentation data for the places the corpus contains.
 * An unknown city is simply not plotted; OpenPong never assumes an owner's area.
 */
const CITY_COORDS: Record<string, [number, number]> = {
  plano: [33.0198, -96.6989],
  austin: [30.2672, -97.7431],
  "round rock": [30.5083, -97.6789],
  houston: [29.7604, -95.3698],
  dallas: [32.7767, -96.797],
  "fort worth": [32.7555, -97.3308],
  "san antonio": [29.4241, -98.4936],
  katy: [29.7858, -95.8245],
  frisco: [33.1507, -96.8236],
  richardson: [32.9483, -96.7299],
  irving: [32.814, -96.9489],
  allen: [33.1032, -96.6706],
  colleyville: [32.8807, -97.155],
  lubbock: [33.5779, -101.8552],
  "el paso": [31.7619, -106.485],
  arlington: [32.7357, -97.1081],
  mckinney: [33.1972, -96.6397],
  carrollton: [32.9537, -96.8903],
  garland: [32.9126, -96.6389],
  pearland: [29.5636, -95.286],
  "sugar land": [29.6197, -95.6349],
  "las vegas": [36.1699, -115.1398],
  burlingame: [37.5841, -122.3661],
  "new york": [40.7128, -74.006],
  "los angeles": [34.0522, -118.2437],
  "san francisco": [37.7749, -122.4194],
  "san diego": [32.7157, -117.1611],
  chicago: [41.8781, -87.6298],
};

function coordsFor(tournament: Tournament): [number, number] | undefined {
  const haystack = `${tournament.city_state ?? ""} ${tournament.location ?? ""}`.toLowerCase();
  for (const [city, coords] of Object.entries(CITY_COORDS)) {
    if (haystack.includes(city)) return coords;
  }
  return undefined;
}

const pin = divIcon({
  className: "",
  html: '<div style="width:14px;height:14px;border-radius:50%;background:#c9ff4d;border:2px solid #070b0d;box-shadow:0 0 0 4px rgba(201,255,77,.25)"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
  popupAnchor: [0, -10],
});

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) map.setView(points[0], 9);
    else map.fitBounds(latLngBounds(points), { padding: [40, 40] });
  }, [map, points]);
  return null;
}

export default function TournamentMap({ tournaments }: { tournaments: Tournament[] }) {
  const placed = useMemo(
    () =>
      tournaments
        .map((tournament) => ({ tournament, coords: coordsFor(tournament) }))
        .filter((entry): entry is { tournament: Tournament; coords: [number, number] } =>
          Boolean(entry.coords),
        ),
    [tournaments],
  );
  const points = placed.map((entry) => entry.coords);

  return (
    <div className="relative h-[520px] overflow-hidden rounded-xl border border-border">
      <MapContainer
        center={[39, -96]}
        zoom={3}
        scrollWheelZoom={false}
        className="h-full w-full"
        attributionControl={false}
      >
        <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
        <FitBounds points={points} />
        {placed.map(({ tournament, coords }) => (
          <Marker key={`${tournament.title}-${coords.join(",")}`} position={coords} icon={pin}>
            <Popup>
              <div style={{ minWidth: 200 }}>
                <strong style={{ display: "block", marginBottom: 4 }}>{tournament.title}</strong>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{tournament.date_range}</div>
                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
                  {tournament.city_state || tournament.location}
                </div>
                {tournament.omnipong_url && (
                  <a
                    href={tournament.omnipong_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "#c9ff4d", fontSize: 12 }}
                  >
                    Open on OmniPong →
                  </a>
                )}
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
      <div className="pointer-events-none absolute left-3 top-3 z-[500] flex gap-2">
        <Badge variant="accent">{placed.length} mapped</Badge>
        {placed.length < tournaments.length && (
          <Badge variant="outline">{tournaments.length - placed.length} without coordinates</Badge>
        )}
      </div>
    </div>
  );
}
