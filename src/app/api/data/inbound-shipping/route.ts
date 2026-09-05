import { NextRequest, NextResponse } from 'next/server';
import { marketToday, marketDaysAgo, addDays } from '@/lib/market-day';
import { openDb } from '@/lib/db-conn';
import { marketplaceParam } from '@/lib/request-params';
import { createLogger } from '@/lib/log';

const log = createLogger('api/data/inbound-shipping');

const getDb = () => openDb({ readonly: true });

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const db = getDb();

  let startDate = searchParams.get('startDate');
  let endDate = searchParams.get('endDate');
  if (!startDate) {
    const days = parseInt(searchParams.get('days') || '30');
    startDate = marketDaysAgo(days);
  }
  if (!endDate) {
    endDate = marketToday();
  }
  const endDateNext = addDays(endDate, 1);

  const marketplace = marketplaceParam(searchParams);
  const MF = marketplace ? `AND marketplace = '${marketplace}'` : '';

  try {
    const shipments = db.prepare(`
      SELECT
        shipment_id as shipmentId,
        date_shipped as dateShipped,
        carrier,
        tracking,
        boxes,
        weight,
        cost,
        total_units as totalUnits,
        status,
        marketplace
      FROM inbound_shipments
      WHERE date_shipped >= ? AND date_shipped < ? ${MF}
      ORDER BY date_shipped DESC
    `).all(startDate, endDateNext) as any[];

    const getItems = db.prepare(`
      SELECT isi.asin, isi.sku, isi.quantity, COALESCE(p.name, isi.asin) as productName
      FROM inbound_shipment_items isi
      LEFT JOIN products p ON isi.asin = p.asin
      WHERE isi.shipment_id = ?
    `);

    const items = shipments.map((shipment) => ({
      ...shipment,
      items: getItems.all(shipment.shipmentId) as any[],
    }));

    const totalShipments = items.length;
    const totalUnits = items.reduce((s, i) => s + i.totalUnits, 0);

    // Get inbound shipping costs from fee_details (FBA transport + convenience fees)
    const costData = db.prepare(`
      SELECT COALESCE(-SUM(amount), 0) as total
      FROM fee_details
      WHERE fee_type IN ('FBAInboundTransportationFee', 'FBAInboundConvenienceFee', 'FBAInboundTransportationProgramFee')
        AND date(posted_date) >= ? AND date(posted_date) < ?
    `).get(startDate, endDateNext) as any;

    const totalCost = costData?.total || 0;

    db.close();

    return NextResponse.json({
      items,
      totals: { totalShipments, totalCost, totalUnits },
    });
  } catch (error) {
    db.close();
    log.error('Inbound Shipping API error:', error);
    return NextResponse.json({ error: 'Failed to load inbound shipping data' }, { status: 500 });
  }
}
