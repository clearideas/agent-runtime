# Storefront on-call runbook

Start with the customer impact, then follow the request path from the edge to the data stores. Prefer rollback over forward fixes during an incident.

## api-gateway

Owner: team-api. Escalation: page the secondary after 15 minutes.

### Symptoms

- api-gateway reports elevated error rates.
- api-gateway reports elevated latency.
- api-gateway reports elevated timeouts.
- api-gateway reports elevated queue depth.

### Checks

1. Open the api-gateway dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for api-gateway in the change log; note the ticket and the exact time each change was applied.
3. Confirm that api-gateway health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for api-gateway.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to api-gateway correlates with the errors, roll it back first and investigate afterwards.
- If api-gateway is saturated without a recent change, scale out by two instances and page the owning team.
- If api-gateway depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

api-gateway handled 750 requests per second at peak last quarter, with a p99 latency budget of 531ms and an error budget of 0.3%. api-gateway handled 331 requests per second at peak last quarter, with a p99 latency budget of 493ms and an error budget of 0.5%. api-gateway handled 312 requests per second at peak last quarter, with a p99 latency budget of 717ms and an error budget of 0.8%. api-gateway handled 578 requests per second at peak last quarter, with a p99 latency budget of 324ms and an error budget of 0.9%.

## auth

Owner: team-auth. Escalation: page the secondary after 15 minutes.

### Symptoms

- auth reports elevated error rates.
- auth reports elevated latency.
- auth reports elevated timeouts.
- auth reports elevated queue depth.

### Checks

1. Open the auth dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for auth in the change log; note the ticket and the exact time each change was applied.
3. Confirm that auth health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for auth.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to auth correlates with the errors, roll it back first and investigate afterwards.
- If auth is saturated without a recent change, scale out by two instances and page the owning team.
- If auth depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

auth handled 306 requests per second at peak last quarter, with a p99 latency budget of 583ms and an error budget of 0.9%. auth handled 299 requests per second at peak last quarter, with a p99 latency budget of 344ms and an error budget of 0.7%. auth handled 879 requests per second at peak last quarter, with a p99 latency budget of 504ms and an error budget of 0.5%. auth handled 234 requests per second at peak last quarter, with a p99 latency budget of 861ms and an error budget of 0.3%.

## cart

Owner: team-cart. Escalation: page the secondary after 15 minutes.

### Symptoms

- cart reports elevated error rates.
- cart reports elevated latency.
- cart reports elevated timeouts.
- cart reports elevated queue depth.

### Checks

1. Open the cart dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for cart in the change log; note the ticket and the exact time each change was applied.
3. Confirm that cart health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for cart.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to cart correlates with the errors, roll it back first and investigate afterwards.
- If cart is saturated without a recent change, scale out by two instances and page the owning team.
- If cart depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

cart handled 243 requests per second at peak last quarter, with a p99 latency budget of 428ms and an error budget of 0.1%. cart handled 339 requests per second at peak last quarter, with a p99 latency budget of 832ms and an error budget of 0.1%. cart handled 481 requests per second at peak last quarter, with a p99 latency budget of 748ms and an error budget of 0.7%. cart handled 379 requests per second at peak last quarter, with a p99 latency budget of 697ms and an error budget of 0.8%.

## catalog

Owner: team-catalog. Escalation: page the secondary after 15 minutes.

### Symptoms

- catalog reports elevated error rates.
- catalog reports elevated latency.
- catalog reports elevated timeouts.
- catalog reports elevated queue depth.

### Checks

1. Open the catalog dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for catalog in the change log; note the ticket and the exact time each change was applied.
3. Confirm that catalog health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for catalog.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to catalog correlates with the errors, roll it back first and investigate afterwards.
- If catalog is saturated without a recent change, scale out by two instances and page the owning team.
- If catalog depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

catalog handled 462 requests per second at peak last quarter, with a p99 latency budget of 417ms and an error budget of 0.9%. catalog handled 662 requests per second at peak last quarter, with a p99 latency budget of 312ms and an error budget of 0.1%. catalog handled 488 requests per second at peak last quarter, with a p99 latency budget of 585ms and an error budget of 0.6%. catalog handled 241 requests per second at peak last quarter, with a p99 latency budget of 874ms and an error budget of 0.8%.

## checkout-api

Owner: team-checkout. Escalation: page the secondary after 15 minutes.

### Symptoms

- checkout-api reports elevated error rates.
- checkout-api reports elevated latency.
- checkout-api reports elevated timeouts.
- checkout-api reports elevated queue depth.

### Checks

1. Open the checkout-api dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for checkout-api in the change log; note the ticket and the exact time each change was applied.
3. Confirm that checkout-api health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for checkout-api.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to checkout-api correlates with the errors, roll it back first and investigate afterwards.
- If checkout-api is saturated without a recent change, scale out by two instances and page the owning team.
- If checkout-api depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

checkout-api handled 592 requests per second at peak last quarter, with a p99 latency budget of 633ms and an error budget of 0.7%. checkout-api handled 609 requests per second at peak last quarter, with a p99 latency budget of 580ms and an error budget of 0.5%. checkout-api handled 692 requests per second at peak last quarter, with a p99 latency budget of 665ms and an error budget of 0.6%. checkout-api handled 533 requests per second at peak last quarter, with a p99 latency budget of 893ms and an error budget of 0.1%.

## cdn-edge

Owner: team-cdn. Escalation: page the secondary after 15 minutes.

### Symptoms

- cdn-edge reports elevated error rates.
- cdn-edge reports elevated latency.
- cdn-edge reports elevated timeouts.
- cdn-edge reports elevated queue depth.

### Checks

1. Open the cdn-edge dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for cdn-edge in the change log; note the ticket and the exact time each change was applied.
3. Confirm that cdn-edge health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for cdn-edge.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to cdn-edge correlates with the errors, roll it back first and investigate afterwards.
- If cdn-edge is saturated without a recent change, scale out by two instances and page the owning team.
- If cdn-edge depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

cdn-edge handled 775 requests per second at peak last quarter, with a p99 latency budget of 348ms and an error budget of 0.8%. cdn-edge handled 249 requests per second at peak last quarter, with a p99 latency budget of 567ms and an error budget of 0.8%. cdn-edge handled 470 requests per second at peak last quarter, with a p99 latency budget of 407ms and an error budget of 0.3%. cdn-edge handled 703 requests per second at peak last quarter, with a p99 latency budget of 395ms and an error budget of 0.2%.

## fraud-check

Owner: team-fraud. Escalation: page the secondary after 15 minutes.

### Symptoms

- fraud-check reports elevated error rates.
- fraud-check reports elevated latency.
- fraud-check reports elevated timeouts.
- fraud-check reports elevated queue depth.

### Checks

1. Open the fraud-check dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for fraud-check in the change log; note the ticket and the exact time each change was applied.
3. Confirm that fraud-check health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for fraud-check.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to fraud-check correlates with the errors, roll it back first and investigate afterwards.
- If fraud-check is saturated without a recent change, scale out by two instances and page the owning team.
- If fraud-check depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

fraud-check handled 579 requests per second at peak last quarter, with a p99 latency budget of 321ms and an error budget of 0.3%. fraud-check handled 853 requests per second at peak last quarter, with a p99 latency budget of 851ms and an error budget of 0.1%. fraud-check handled 600 requests per second at peak last quarter, with a p99 latency budget of 839ms and an error budget of 0.7%. fraud-check handled 797 requests per second at peak last quarter, with a p99 latency budget of 832ms and an error budget of 0.9%.

## inventory

Owner: team-inventory. Escalation: page the secondary after 15 minutes.

### Symptoms

- inventory reports elevated error rates.
- inventory reports elevated latency.
- inventory reports elevated timeouts.
- inventory reports elevated queue depth.

### Checks

1. Open the inventory dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for inventory in the change log; note the ticket and the exact time each change was applied.
3. Confirm that inventory health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for inventory.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to inventory correlates with the errors, roll it back first and investigate afterwards.
- If inventory is saturated without a recent change, scale out by two instances and page the owning team.
- If inventory depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

inventory handled 474 requests per second at peak last quarter, with a p99 latency budget of 792ms and an error budget of 0.9%. inventory handled 617 requests per second at peak last quarter, with a p99 latency budget of 380ms and an error budget of 0.2%. inventory handled 403 requests per second at peak last quarter, with a p99 latency budget of 401ms and an error budget of 0.5%. inventory handled 763 requests per second at peak last quarter, with a p99 latency budget of 776ms and an error budget of 0.8%.

## notifications

Owner: team-notifications. Escalation: page the secondary after 15 minutes.

### Symptoms

- notifications reports elevated error rates.
- notifications reports elevated latency.
- notifications reports elevated timeouts.
- notifications reports elevated queue depth.

### Checks

1. Open the notifications dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for notifications in the change log; note the ticket and the exact time each change was applied.
3. Confirm that notifications health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for notifications.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to notifications correlates with the errors, roll it back first and investigate afterwards.
- If notifications is saturated without a recent change, scale out by two instances and page the owning team.
- If notifications depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

notifications handled 495 requests per second at peak last quarter, with a p99 latency budget of 768ms and an error budget of 0.9%. notifications handled 374 requests per second at peak last quarter, with a p99 latency budget of 686ms and an error budget of 0.4%. notifications handled 519 requests per second at peak last quarter, with a p99 latency budget of 513ms and an error budget of 0.8%. notifications handled 505 requests per second at peak last quarter, with a p99 latency budget of 660ms and an error budget of 0.1%.

## orders

Owner: team-orders. Escalation: page the secondary after 15 minutes.

### Symptoms

- orders reports elevated error rates.
- orders reports elevated latency.
- orders reports elevated timeouts.
- orders reports elevated queue depth.

### Checks

1. Open the orders dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for orders in the change log; note the ticket and the exact time each change was applied.
3. Confirm that orders health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for orders.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to orders correlates with the errors, roll it back first and investigate afterwards.
- If orders is saturated without a recent change, scale out by two instances and page the owning team.
- If orders depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

orders handled 653 requests per second at peak last quarter, with a p99 latency budget of 786ms and an error budget of 0.6%. orders handled 325 requests per second at peak last quarter, with a p99 latency budget of 412ms and an error budget of 0.8%. orders handled 822 requests per second at peak last quarter, with a p99 latency budget of 662ms and an error budget of 0.5%. orders handled 208 requests per second at peak last quarter, with a p99 latency budget of 549ms and an error budget of 0.3%.

## payments-api

Owner: team-payments. Escalation: page the secondary after 15 minutes.

### Symptoms

- payments-api reports elevated error rates.
- payments-api reports elevated latency.
- payments-api reports elevated timeouts.
- payments-api reports elevated queue depth.

### Checks

1. `timeout acquiring connection from pool` means payments-db connections are exhausted; investigate payments-db before payments-api.
2. Open the payments-api dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
3. Check recent deploys and configuration changes for payments-api in the change log; note the ticket and the exact time each change was applied.
4. Confirm that payments-api health checks pass in every zone and that no instance is restarting.
5. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for payments-api.
6. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to payments-api correlates with the errors, roll it back first and investigate afterwards.
- If payments-api is saturated without a recent change, scale out by two instances and page the owning team.
- If payments-api depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

payments-api handled 229 requests per second at peak last quarter, with a p99 latency budget of 586ms and an error budget of 0.7%. payments-api handled 404 requests per second at peak last quarter, with a p99 latency budget of 693ms and an error budget of 0.9%. payments-api handled 504 requests per second at peak last quarter, with a p99 latency budget of 717ms and an error budget of 0.6%. payments-api handled 402 requests per second at peak last quarter, with a p99 latency budget of 634ms and an error budget of 0.1%.

## payments-db

Owner: team-payments. Escalation: page the secondary after 15 minutes.

### Symptoms

- payments-db reports elevated error rates.
- payments-db reports elevated latency.
- payments-db reports elevated timeouts.
- payments-db reports elevated queue depth.

### Checks

1. Check connection pool usage. `pool.max_connections` must stay at 200 in production; values below 100 exhaust the pool at normal checkout volume.
2. Open the payments-db dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
3. Check recent deploys and configuration changes for payments-db in the change log; note the ticket and the exact time each change was applied.
4. Confirm that payments-db health checks pass in every zone and that no instance is restarting.
5. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for payments-db.
6. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If the pool is exhausted after a configuration change, roll back to the previous configuration version; resizing takes about a minute.
- If a recent change to payments-db correlates with the errors, roll it back first and investigate afterwards.
- If payments-db is saturated without a recent change, scale out by two instances and page the owning team.
- If payments-db depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

payments-db handled 877 requests per second at peak last quarter, with a p99 latency budget of 478ms and an error budget of 0.3%. payments-db handled 680 requests per second at peak last quarter, with a p99 latency budget of 562ms and an error budget of 0.9%. payments-db handled 798 requests per second at peak last quarter, with a p99 latency budget of 847ms and an error budget of 0.8%. payments-db handled 743 requests per second at peak last quarter, with a p99 latency budget of 373ms and an error budget of 0.8%.

## pricing

Owner: team-pricing. Escalation: page the secondary after 15 minutes.

### Symptoms

- pricing reports elevated error rates.
- pricing reports elevated latency.
- pricing reports elevated timeouts.
- pricing reports elevated queue depth.

### Checks

1. Open the pricing dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for pricing in the change log; note the ticket and the exact time each change was applied.
3. Confirm that pricing health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for pricing.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to pricing correlates with the errors, roll it back first and investigate afterwards.
- If pricing is saturated without a recent change, scale out by two instances and page the owning team.
- If pricing depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

pricing handled 522 requests per second at peak last quarter, with a p99 latency budget of 494ms and an error budget of 0.9%. pricing handled 250 requests per second at peak last quarter, with a p99 latency budget of 523ms and an error budget of 0.9%. pricing handled 750 requests per second at peak last quarter, with a p99 latency budget of 426ms and an error budget of 0.5%. pricing handled 360 requests per second at peak last quarter, with a p99 latency budget of 465ms and an error budget of 0.4%.

## search

Owner: team-search. Escalation: page the secondary after 15 minutes.

### Symptoms

- search reports elevated error rates.
- search reports elevated latency.
- search reports elevated timeouts.
- search reports elevated queue depth.

### Checks

1. Open the search dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for search in the change log; note the ticket and the exact time each change was applied.
3. Confirm that search health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for search.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to search correlates with the errors, roll it back first and investigate afterwards.
- If search is saturated without a recent change, scale out by two instances and page the owning team.
- If search depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

search handled 271 requests per second at peak last quarter, with a p99 latency budget of 785ms and an error budget of 0.3%. search handled 348 requests per second at peak last quarter, with a p99 latency budget of 684ms and an error budget of 0.7%. search handled 437 requests per second at peak last quarter, with a p99 latency budget of 573ms and an error budget of 0.4%. search handled 843 requests per second at peak last quarter, with a p99 latency budget of 352ms and an error budget of 0.8%.

## shipping

Owner: team-shipping. Escalation: page the secondary after 15 minutes.

### Symptoms

- shipping reports elevated error rates.
- shipping reports elevated latency.
- shipping reports elevated timeouts.
- shipping reports elevated queue depth.

### Checks

1. Open the shipping dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for shipping in the change log; note the ticket and the exact time each change was applied.
3. Confirm that shipping health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for shipping.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to shipping correlates with the errors, roll it back first and investigate afterwards.
- If shipping is saturated without a recent change, scale out by two instances and page the owning team.
- If shipping depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

shipping handled 726 requests per second at peak last quarter, with a p99 latency budget of 623ms and an error budget of 0.9%. shipping handled 762 requests per second at peak last quarter, with a p99 latency budget of 578ms and an error budget of 0.6%. shipping handled 632 requests per second at peak last quarter, with a p99 latency budget of 462ms and an error budget of 0.1%. shipping handled 338 requests per second at peak last quarter, with a p99 latency budget of 363ms and an error budget of 0.4%.

## tax

Owner: team-tax. Escalation: page the secondary after 15 minutes.

### Symptoms

- tax reports elevated error rates.
- tax reports elevated latency.
- tax reports elevated timeouts.
- tax reports elevated queue depth.

### Checks

1. Open the tax dashboard and compare request rate, error rate, and p99 latency with the same hour last week.
2. Check recent deploys and configuration changes for tax in the change log; note the ticket and the exact time each change was applied.
3. Confirm that tax health checks pass in every zone and that no instance is restarting.
4. Look for saturation: CPU, memory, connection pools, thread pools, and queue depth for tax.
5. Compare the first error timestamp with deploy times; a change applied minutes before the first error is the leading suspect.

### Mitigation

- If a recent change to tax correlates with the errors, roll it back first and investigate afterwards.
- If tax is saturated without a recent change, scale out by two instances and page the owning team.
- If tax depends on a failing upstream, enable its circuit breaker and serve degraded responses.
- Record every action, with the time, in the incident channel.

### Notes

tax handled 273 requests per second at peak last quarter, with a p99 latency budget of 330ms and an error budget of 0.7%. tax handled 478 requests per second at peak last quarter, with a p99 latency budget of 894ms and an error budget of 0.5%. tax handled 404 requests per second at peak last quarter, with a p99 latency budget of 457ms and an error budget of 0.9%. tax handled 529 requests per second at peak last quarter, with a p99 latency budget of 390ms and an error budget of 0.5%.
